export class CloudError extends Error {
  constructor(message, {code = 'CLOUD_NETWORK', status = 0, retryable = false} = {}) {
    super(message); this.name = 'CloudError'; this.code = code; this.status = status; this.retryable = retryable;
  }
}

function responseError(response, data) {
  const status = response.status;
  const messages = {
    401: 'Сеанс входа завершён. Войдите через Google ещё раз.',
    403: 'Нет доступа к закрытому облаку. Нужно проверить настройку доступа на этом ПК.',
    404: 'Облачный адрес не найден. Проверьте версию приложения.',
    429: 'Облако получило слишком много запросов. Подождите немного.',
  };
  const code = typeof data?.code === 'string' && /^CLOUD_[A-Z_]{1,40}$/.test(data.code) ? data.code : `HTTP_${status}`;
  const message = typeof data?.error === 'string' && data.error.length <= 600 ? data.error :
    messages[status] || 'Облачный сервис временно недоступен. Повторим подключение автоматически.';
  return new CloudError(message, {code, status, retryable: status === 429 || status >= 500});
}

/** Only GETs are retried. A timed-out write may already have reached the server. */
export async function requestCloudJson(path, options = {}, {fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  const attempts = (options.method || 'GET').toUpperCase() === 'GET' ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let failure;
    try {
      const response = await fetchImpl(path, {...options, signal: AbortSignal.timeout(30000)});
      let data;
      try { data = await response.json(); }
      catch {
        if (!response.ok) throw responseError(response, null);
        throw new CloudError('Сервер вернул ответ вместо данных облака. Подключение будет проверено повторно.', {code: 'CLOUD_RESPONSE', status: response.status, retryable: true});
      }
      if (!response.ok) throw responseError(response, data);
      return data;
    } catch (error) {
      failure = error instanceof CloudError ? error : new CloudError(
        error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Облако не ответило вовремя. Повторим подключение автоматически.' : 'Не удалось связаться с облаком. Повторим подключение автоматически.',
        {code: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'CLOUD_TIMEOUT' : 'CLOUD_NETWORK', retryable: true});
    }
    if (!failure.retryable || attempt === attempts - 1) throw failure;
    await wait(700);
  }
}

export function readCloudJson(path, dependencies) { return requestCloudJson(path, {}, dependencies); }
