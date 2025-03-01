import { Redis } from '@upstash/redis';

// Khởi tạo client Upstash Redis từ biến môi trường được Cloudflare cung cấp
let upstashRedisClient = null;
if (
  typeof UPSTASH_REDIS_REST_URL !== 'undefined' &&
  typeof UPSTASH_REDIS_REST_TOKEN !== 'undefined'
) {
  upstashRedisClient = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  });
}

// Default cookie prefixes cho bypass cache
const DEFAULT_BYPASS_COOKIES = ['wp-', 'wordpress', 'comment_', 'woocommerce_'];

/**
 * Main worker entry point.
 */
addEventListener('fetch', event => {
  const request = event.request;
  let upstreamCache = request.headers.get('x-HTML-Edge-Cache');

  // Sử dụng Upstash Redis để quản lý cache (nếu đã cấu hình)
  if (upstashRedisClient && !upstreamCache) {
    event.passThroughOnException();
    event.respondWith(processRequest(request, event));
  }
});

/**
 * Xử lý các request:
 * - Kiểm tra cache từ Upstash Redis
 * - Nếu không có cache, gửi request đến origin, kiểm tra lệnh purge và lưu cache (nếu cần)
 * - Thêm header kiểm tra trạng thái của worker và kết nối Upstash Redis.
 */
async function processRequest(originalRequest, event) {
  let cfCacheStatus = null;
  const accept = originalRequest.headers.get('Accept');
  const isHTML = accept && accept.indexOf('text/html') >= 0;
  let { response, cacheVer, status, bypassCache } = await getCachedResponse(originalRequest);

  if (response === null) {
    // Gửi request đến origin với header thông báo hỗ trợ cache
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
        isHTML &&
        originalRequest.method === 'GET' &&
        response.status === 200 &&
        !bypassCache
      ) {
        status += await cacheResponse(cacheVer, originalRequest, response, event);
      }
    }
  } else {
    // Nếu đã có cache, dùng stale-while-revalidate
    cfCacheStatus = 'HIT';
    if (originalRequest.method === 'GET' && response.status === 200 && isHTML) {
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
    response.status === 200 &&
    isHTML
  ) {
    response = new Response(response.body, response);
    response.headers.set('x-HTML-Edge-Cache-Status', status);
    if (cacheVer !== null) {
      response.headers.set('x-HTML-Edge-Cache-Version', cacheVer.toString());
    }
    if (cfCacheStatus) {
      response.headers.set('CF-Cache-Status', cfCacheStatus);
    }
  }

  // Thêm header kiểm tra hoạt động của worker và trạng thái kết nối với Upstash Redis
  response = new Response(response.body, response);
  response.headers.set('x-worker-status', 'OK');
  if (upstashRedisClient) {
    try {
      const ping = await upstashRedisClient.ping();
      response.headers.set('x-upstash-status', ping === 'PONG' ? 'OK' : 'Error');
    } catch (e) {
      response.headers.set('x-upstash-status', 'Error');
    }
  } else {
    response.headers.set('x-upstash-status', 'Not Configured');
  }

  return response;
}

/**
 * Kiểm tra xem có cần bypass cache không dựa trên các cookie trong request.
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

/**
 * Kiểm tra cache cho các request GET HTML bằng cách truy xuất từ Upstash Redis.
 */
async function getCachedResponse(request) {
  let response = null;
  let cacheVer = await GetCurrentCacheVersion(null);
  let bypassCache = false;
  let status = 'Miss';
  const accept = request.headers.get('Accept');
  const cacheControl = request.headers.get('Cache-Control');
  let noCache = false;
  if (cacheControl && cacheControl.indexOf('no-cache') !== -1) {
    noCache = true;
    status = 'Bypass for Reload';
  }
  if (!noCache && request.method === 'GET' && accept && accept.indexOf('text/html') >= 0) {
    const cacheKey = GenerateCacheKey(request, cacheVer);
    try {
      const cached = await upstashRedisClient.get(cacheKey);
      if (cached) {
        let cachedObj = JSON.parse(cached);
        response = new Response(cachedObj.body, {
          status: cachedObj.status,
          headers: cachedObj.headers,
        });
        bypassCache = shouldBypassEdgeCache(request, response);
        status = bypassCache ? 'Bypass Cookie' : 'Hit';
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
 * Lưu trữ response HTML GET thành công vào Upstash Redis.
 */
async function cacheResponse(cacheVer, request, originalResponse, event) {
  let status = '';
  const accept = request.headers.get('Accept');
  if (
    request.method === 'GET' &&
    originalResponse.status === 200 &&
    accept &&
    accept.indexOf('text/html') >= 0
  ) {
    cacheVer = await GetCurrentCacheVersion(cacheVer);
    const cacheKey = GenerateCacheKey(request, cacheVer);
    try {
      const clone = originalResponse.clone();
      const bodyText = await clone.text();
      let headersObj = {};
      clone.headers.forEach((value, key) => {
        headersObj[key] = value;
      });
      const cacheObj = {
        status: clone.status,
        headers: headersObj,
        body: bodyText,
      };
      event.waitUntil(upstashRedisClient.set(cacheKey, JSON.stringify(cacheObj)));
      status = ', Cached';
    } catch (err) {
      // Có thể log lỗi nếu cần: err.message
    }
  }
  return status;
}

/**
 * Purge cache bằng cách tăng phiên bản cache trong Upstash Redis.
 */
async function purgeCache(cacheVer, event) {
  cacheVer = await GetCurrentCacheVersion(cacheVer);
  cacheVer++;
  event.waitUntil(upstashRedisClient.set('html_cache_version', cacheVer.toString()));
}

/**
 * Cập nhật cache một cách không đồng bộ (stale-while-revalidate).
 */
async function updateCache(originalRequest, cacheVer, event) {
  let request = new Request(originalRequest);
  request.headers.set('x-HTML-Edge-Cache', 'supports=cache|purgeall|bypass-cookies');
  let response = await fetch(request);
  if (response) {
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
 * Phân tích header của response từ origin để xác định lệnh cache, purge và bypass cookies.
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
 * Lấy phiên bản cache hiện tại từ Upstash Redis.
 */
async function GetCurrentCacheVersion(cacheVer) {
  if (cacheVer === null) {
    cacheVer = await upstashRedisClient.get('html_cache_version');
    if (cacheVer === null) {
      cacheVer = 0;
      await upstashRedisClient.set('html_cache_version', cacheVer.toString());
    } else {
      cacheVer = parseInt(cacheVer);
    }
  }
  return cacheVer;
}

/**
 * Tạo key cache dựa trên URL request và phiên bản cache.
 */
function GenerateCacheKey(request, cacheVer) {
  let cacheUrl = request.url;
  if (cacheUrl.indexOf('?') >= 0) {
    cacheUrl += '&';
  } else {
    cacheUrl += '?';
  }
  cacheUrl += 'cf_edge_cache_ver=' + cacheVer;
  return 'cf_edge_cache:' + cacheUrl;
}
