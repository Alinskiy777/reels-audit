// Cloudflare Worker — Instagram Reels Proxy
// Принимает ссылку на Reel, возвращает данные (лайки, комменты, просмотры)
// 🔴 ВАЖНО: sessionid должен быть в переменных окружения Cloudflare Worker!
// Настройка: Cloudflare Dashboard → Workers & Pages → reels-audit-worker → Settings → Variables

// Валидация URL
function isValidInstagramUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.length > 2048) return false; // Максимальная длина URL
  try {
    const u = new URL(url);
    return (u.hostname === 'www.instagram.com' || u.hostname === 'instagram.com') 
           && u.pathname.includes('/reel/');
  } catch {
    return false;
  }
}

// Извлечение shortcode из URL
function extractShortcode(url) {
  const match = url.match(/\/reel\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

async function fetchReelData(url, env) {
  // Валидация URL
  if (!isValidInstagramUrl(url)) {
    return { error: 'Некорректная ссылка. Нужна ссылка на Instagram Reel (https://www.instagram.com/reel/...)' };
  }

  // Извлекаем shortcode
  const shortcode = extractShortcode(url);
  if (!shortcode) {
    return { error: 'Не могу найти shortcode в ссылке' };
  }

  // Проверяем что sessionid настроен
  const IG_SESSION = env?.IG_SESSION || '';
  if (!IG_SESSION) {
    return { error: 'Ошибка конфигурации: Instagram sessionid не настроен' };
  }

  // Запрашиваем страницу Reel с таймаутом
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд таймаут

  try {
    const response = await fetch(`https://www.instagram.com/reel/${shortcode}/`, {
      headers: {
        'Cookie': `sessionid=${IG_SESSION}; csrftoken=missing`,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://www.instagram.com/',
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    timeoutId = null;

    // Проверяем статус ответа
    if (!response.ok) {
      return { error: `Instagram вернул ошибку: ${response.status} ${response.statusText}` };
    }

    const html = await response.text();

    // Проверяем что ответ не пустой
    if (!html || html.length < 100) {
      return { error: 'Instagram вернул пустой ответ' };
    }

    // Парсим og:description
    const ogMatch = html.match(/property="og:description" content="([^"]+)"/);
    if (!ogMatch) {
      return { error: 'Не могу найти данные на странице' };
    }

    const ogDesc = ogMatch[1];
    
    // Парсим лайки, комменты, дату, хук
    const dataMatch = ogDesc.match(/([\d.,]+)\s*likes?,\s*([\d.,]+[KMB]?)\s*comments?\s*-\s*\S+\s*on\s*(.+?):\s*"([^"]*)"/);
    
    if (!dataMatch) {
      return { error: 'Не могу распарсить данные', og: ogDesc };
    }

    return {
      likes: parseCount(dataMatch[1]),
      comments: parseCount(dataMatch[2]),
      date: dataMatch[3].trim(),
      hook: dataMatch[4].trim(),
      shortcode: shortcode,
      url: url
    };
  } catch (e) {
    if (timeoutId) clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      return { error: 'Таймаут: Instagram не ответил за 10 секунд' };
    }
    return { error: `Ошибка запроса: ${e.message}` };
  }
}

function parseCount(s) {
  if (!s) return null;
  s = s.trim().replace(/,/g, '');
  const mult = s.endsWith('K') ? 1000 : s.endsWith('M') ? 1000000 : 1;
  if (mult > 1) s = s.slice(0, -1);
  return Math.round(parseFloat(s) * mult);
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event.env))
})

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const reelUrl = url.searchParams.get('url');

  if (!reelUrl) {
    return new Response(JSON.stringify({ error: 'Нужна ссылка на Reel (?url=...)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const data = await fetchReelData(reelUrl, env);
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=300'
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
