// Yêu cầu: Một KV Namespace phải được bind với worker script này bằng biến EDGE_CACHE.

// Default cookie prefixes for bypass
const DEFAULT_BYPASS_COOKIES = ['wp-', 'wordpress', 'comment_', 'woocommerce_'];

/**
 * Main worker entry point.
 */
addEventListener('fetch', event => {
  const request = event.request;
  let upstreamCache = request.headers.get('x-HTML-Edge-Cache');

  // Chỉ xử lý request khi đã bind KV (EDGE_CACHE) và không có HTML edge cache ở phía trước worker
  const configured = (typeof EDGE_CACHE !== 'undefined');

  // Nếu muốn loại trừ ảnh, bạn có thể kiểm tra Accept, ví dụ:
  // const accept = request.headers.get('Accept');
  // let isImage = accept && accept.indexOf('image/*') !== -1;
  // Tuy nhiên, nếu bạn muốn xử lý toàn bộ header Accept bất kể là gì,
  // ta bỏ qua điều kiện loại trừ cho hình ảnh.
  
  if (configured && upstreamCache === null) {
    event.passThroughOnException();
    event.respondWith(processRequest(request, event));
  }
});

/**
 * Process every request coming through to add the edge-cache header,
 * watch for purge responses and possibly cache GET requests (đối với tất cả các Accept header).
 *
 * @param {Request} originalRequest - Original request
 * @param {Event} event - Original event (for additional async waiting)
 */
async function processRequest(originalRequest, event) {
  let cfCacheStatus = null;
  // Lấy header Accept nhưng không dùng để lọc loại nội dung
  const accept = originalRequest.headers.get('Accept');
  let { response, cacheVer, status, bypassCache } = await getCachedResponse(originalRequest);

  if (response === null) {
    // Clone request, thêm header edge-cache và gửi đi.
    let request = new Request(originalRequest);
    request.headers.set('x-HTML-Edge-Cache', 'supports=cache|purgeall|bypass-cookies');
    response = await fetch(request);

    if (response) {
      const options = getResponseOptions(response);
      if (options && options.purge) {
        await purgeCache(cacheVer, event);
        status += ', Purged';
      }
      bypassCache = bypassCache || shouldBypassEdgeCache(request, response);
      if (
        (!options || options.cache) &&
        originalRequest.method === 'GET' &&
        response.status === 200 &&
        !bypassCache
      ) {
        status += await cacheResponse(cacheVer, originalRequest, response, event);
      }
    }
  } else {
    // Nếu có cached response, thực hiện stale-while-revalidate.
    cfCacheStatus = 'HIT';
    if (originalRequest.method === 'GET' && response.status === 200) {
      bypassCache = bypassCache || shouldBypassEdgeCache(originalRequest, response);
      if (!bypassCache) {
        const options = getResponseOptions(response);
        if (!options) {
          status += ', Refreshed';
          event.waitUntil(updateCache(originalRequest, cacheVer, event));
        }
      }
    }
  }

  if (
    response &&
    status !== null &&
    originalRequest.method === 'GET' &&
    response.status === 200
  ) {
    response = new Response(response.body, response);
    response.headers.set('x-HTML-Edge-Cache-Status', status);
    if (cacheVer !== null) {
      response.headers.set('x-HTML-Edge-Cache-Version', cacheVer.toString());
    }
    if (cfCacheStatus) {
      response.headers.set('CF-Cache-Status', cfCacheStatus);
    }
    // Header báo hiệu Worker đang hoạt động.
    response.headers.set('x-worker-health', 'active');
    // Header cho biết nguồn của dữ liệu: "cache" nếu cache hit, ngược lại "origin"
    response.headers.set('x-cache-source', cfCacheStatus === 'HIT' ? 'cache' : 'origin');
  }

  return response;
}

/**
 * Determine if the cache should be bypassed for the given request/response pair.
 * Nếu request chứa cookie khớp với bypass, sẽ trả về true.
 *
 * @param {Request} request - Request
 * @param {Response} response - Response
 * @returns {bool} true nếu cần bypass cache.
 */
function shouldBypassEdgeCache(request, response) {
  let bypassCache = false;

  if (request && response) {
    const options = getResponseOptions(response);
    const cookieHeader = request.headers.get('cookie');
    let bypassCookies = DEFAULT_BYPASS_COOKIES;
    if (options) {
      bypassCookies = options.bypassCookies;
    }
    if (cookieHeader && cookieHeader.length && bypassCookies.length) {
      const cookies = cookieHeader.split(';');
      for (let cookie of cookies) {
        for (let prefix of bypassCookies) {
          if (cookie.trim().startsWith(prefix)) {
            bypassCache = true;
            break;
          }
        }
        if (bypassCache) break;
      }
    }
  }

  return bypassCache;
}

const CACHE_HEADERS = ['Cache-Control', 'Expires', 'Pragma'];

/**
 * Check for cached GET requests.
 *
 * @param {Request} request - Original request
 */
async function getCachedResponse(request) {
  let response = null;
  let cacheVer = null;
  let bypassCache = false;
  let status = 'Miss';

  const cacheControl = request.headers.get('Cache-Control');
  let noCache = false;
  if (cacheControl && cacheControl.indexOf('no-cache') !== -1) {
    noCache = true;
    status = 'Bypass for Reload';
  }
  if (!noCache && request.method === 'GET') {
    // Tạo URL có phiên bản cho cache
    cacheVer = await GetCurrentCacheVersion(cacheVer);
    const cacheKeyRequest = GenerateCacheRequest(request, cacheVer);

    try {
      let cache = caches.default;
      let cachedResponse = await cache.match(cacheKeyRequest);
      if (cachedResponse) {
        cachedResponse = new Response(cachedResponse.body, cachedResponse);
        bypassCache = shouldBypassEdgeCache(request, cachedResponse);
        if (bypassCache) {
          status = 'Bypass Cookie';
        } else {
          status = 'Hit';
          cachedResponse.headers.delete('Cache-Control');
          cachedResponse.headers.delete('x-HTML-Edge-Cache-Status');
          for (let header of CACHE_HEADERS) {
            let value = cachedResponse.headers.get('x-HTML-Edge-Cache-Header-' + header);
            if (value) {
              cachedResponse.headers.delete('x-HTML-Edge-Cache-Header-' + header);
              cachedResponse.headers.set(header, value);
            }
          }
          response = cachedResponse;
        }
      } else {
        status = 'Miss';
      }
    } catch (err) {
      status = 'Cache Read Exception: ' + err.message;
    }
  }

  return { response, cacheVer, status, bypassCache };
}

/**
 * Asynchronously purge the cache bằng cách tăng cache version.
 *
 * @param {Int} cacheVer - Cache version hiện tại.
 * @param {Event} event - Original event
 */
async function purgeCache(cacheVer, event) {
  if (typeof EDGE_CACHE !== 'undefined') {
    cacheVer = await GetCurrentCacheVersion(cacheVer);
    cacheVer++;
    event.waitUntil(EDGE_CACHE.put('html_cache_version', cacheVer.toString()));
  }
}

/**
 * Cập nhật cached copy của trang.
 *
 * @param {Request} originalRequest - Original request
 * @param {String} cacheVer - Cache version
 * @param {Event} event - Original event
 */
async function updateCache(originalRequest, cacheVer, event) {
  let request = new Request(originalRequest);
  request.headers.set('x-HTML-Edge-Cache', 'supports=cache|purgeall|bypass-cookies');
  let response = await fetch(request);

  if (response) {
    let status = ': Fetched';
    const options = getResponseOptions(response);
    if (options && options.purge) {
      await purgeCache(cacheVer, event);
    }
    let bypassCache = shouldBypassEdgeCache(request, response);
    if ((!options || options.cache) && !bypassCache) {
      await cacheResponse(cacheVer, originalRequest, response, event);
    }
  }
}

/**
 * Cache nội dung trả về (chỉ đối với GET request thành công).
 *
 * @param {Int} cacheVer - Cache version hiện tại.
 * @param {Request} request - Original request
 * @param {Response} originalResponse - Response cần cache
 * @param {Event} event - Original event
 * @returns {String} trạng thái cache (ví dụ: ', Cached')
 */
async function cacheResponse(cacheVer, request, originalResponse, event) {
  let status = '';
  if (
    request.method === 'GET' &&
    originalResponse.status === 200
  ) {
    cacheVer = await GetCurrentCacheVersion(cacheVer);
    const cacheKeyRequest = GenerateCacheRequest(request, cacheVer);

    try {
      let cache = caches.default;
      let clonedResponse = originalResponse.clone();
      let response = new Response(clonedResponse.body, clonedResponse);
      for (let header of CACHE_HEADERS) {
        let value = response.headers.get(header);
        if (value) {
          response.headers.delete(header);
          response.headers.set('x-HTML-Edge-Cache-Header-' + header, value);
        }
      }
      response.headers.delete('Set-Cookie');
      response.headers.set('Cache-Control', 'public; max-age=315360000');
      event.waitUntil(cache.put(cacheKeyRequest, response));
      status = ', Cached';
    } catch (err) {
      // Có thể log lỗi: err.message
    }
  }
  return status;
}

/******************************************************************************
 * Utility Functions
 *****************************************************************************/

/**
 * Parse các lệnh từ header x-HTML-Edge-Cache trong response.
 *
 * @param {Response} response - HTTP response từ origin.
 * @returns {*} Lệnh đã parse.
 */
function getResponseOptions(response) {
  let options = null;
  let header = response.headers.get('x-HTML-Edge-Cache');
  if (header) {
    options = {
      purge: false,
      cache: false,
      bypassCookies: [],
    };
    let commands = header.split(',');
    for (let command of commands) {
      if (command.trim() === 'purgeall') {
        options.purge = true;
      } else if (command.trim() === 'cache') {
        options.cache = true;
      } else if (command.trim().startsWith('bypass-cookies')) {
        let separator = command.indexOf('=');
        if (separator >= 0) {
          let cookies = command.substr(separator + 1).split('|');
          for (let cookie of cookies) {
            cookie = cookie.trim();
            if (cookie.length) {
              options.bypassCookies.push(cookie);
            }
          }
        }
      }
    }
  }
  return options;
}

/**
 * Lấy cache version hiện tại từ KV.
 *
 * @param {Int} cacheVer - Giá trị cache version hiện tại nếu có.
 * @returns {Int} Cache version hiện tại.
 */
async function GetCurrentCacheVersion(cacheVer) {
  if (cacheVer === null) {
    if (typeof EDGE_CACHE !== 'undefined') {
      cacheVer = await EDGE_CACHE.get('html_cache_version');
      if (cacheVer === null) {
        cacheVer = 0;
        await EDGE_CACHE.put('html_cache_version', cacheVer.toString());
      } else {
        cacheVer = parseInt(cacheVer);
      }
    } else {
      cacheVer = -1;
    }
  }
  return cacheVer;
}

/**
 * Tạo Request có phiên bản để sử dụng trong cache operations.
 *
 * @param {Request} request - Request gốc
 * @param {Int} cacheVer - Cache version hiện tại (phải có)
 * @returns {Request} Request đã được version hóa.
 */
function GenerateCacheRequest(request, cacheVer) {
  let cacheUrl = request.url;
  if (cacheUrl.indexOf('?') >= 0) {
    cacheUrl += '&';
  } else {
    cacheUrl += '?';
  }
  cacheUrl += 'cf_edge_cache_ver=' + cacheVer;
  return new Request(cacheUrl);
}
