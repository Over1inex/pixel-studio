export const MAX_BODY_BYTES = 15 * 1024 * 1024;
export const MAX_PROJECTS = 30;

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function checkSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AppError("Запрос отклонён. Откройте редактор заново и повторите действие.", 403);
  }
}

export async function readPayload(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) {
    throw new AppError("Ожидается проект в формате JSON.", 415);
  }
  const advertised = Number(request.headers.get("content-length"));
  if (advertised > MAX_BODY_BYTES) throw new AppError("Проект слишком большой: максимум 15 МБ.", 413);
  if (!request.body) throw new AppError("Проект пуст.");
  const reader = request.body.getReader();
  let length = 0;
  const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AppError("Проект слишком большой: максимум 15 МБ.", 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new AppError("Не удалось прочитать файл проекта."); }
  return validateProjectPayload(payload);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pngDimensions(image) {
  if (typeof image !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    throw new AppError("Слой должен содержать PNG-изображение.");
  }
  const encoded = image.slice(22);
  if (encoded.length % 4 !== 0 || encoded.length < 60) throw new AppError("PNG-слой повреждён.");
  const header = atob(encoded.slice(0, 44));
  if (header.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || header.slice(8, 16) !== "\x00\x00\x00\rIHDR") {
    throw new AppError("PNG-слой повреждён.");
  }
  const readInt = (start) => ((header.charCodeAt(start) * 0x1000000) +
    (header.charCodeAt(start + 1) << 16) + (header.charCodeAt(start + 2) << 8) + header.charCodeAt(start + 3));
  return [readInt(16), readInt(20)];
}

export function validateProjectPayload(payload) {
  if (!isObject(payload) || typeof payload.name !== "string") throw new AppError("Укажите название проекта.");
  const name = payload.name.trim();
  if (!name || name.length > 120 || /[\u0000-\u001f]/.test(name)) throw new AppError("Название должно содержать от 1 до 120 символов.");
  const doc = payload.document;
  if (!isObject(doc) || doc.version !== 1) throw new AppError("Эта версия файла проекта не поддерживается.");
  if (!Number.isInteger(doc.width) || !Number.isInteger(doc.height) || doc.width < 1 || doc.height < 1 ||
    doc.width > 4096 || doc.height > 4096 || doc.width * doc.height > 8_388_608) {
    throw new AppError("Размер холста должен быть от 1 до 4096 пикселей, максимум 8 млн пикселей.");
  }
  if (!Array.isArray(doc.layers) || doc.layers.length < 1 || doc.layers.length > 16) {
    throw new AppError("В проекте должно быть от 1 до 16 слоёв.");
  }
  if (doc.layers.length * doc.width * doc.height > 16_777_216) {
    throw new AppError("Слишком много крупных слоёв. Уменьшите размер холста или количество слоёв.");
  }
  const ids = new Set();
  const layers = doc.layers.map((layer) => {
    if (!isObject(layer) || typeof layer.id !== "string" || layer.id.length < 1 || layer.id.length > 80 || ids.has(layer.id)) {
      throw new AppError("Некорректный идентификатор слоя.");
    }
    ids.add(layer.id);
    if (typeof layer.name !== "string" || layer.name.length > 120 || typeof layer.visible !== "boolean" ||
      typeof layer.opacity !== "number" || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) {
      throw new AppError("Настройки слоя повреждены.");
    }
    const [width, height] = pngDimensions(layer.image);
    if (width !== doc.width || height !== doc.height) throw new AppError("Размер PNG-слоя не совпадает с холстом.");
    return { id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, image: layer.image };
  });
  if (!ids.has(doc.activeId)) throw new AppError("Активный слой отсутствует в проекте.");
  return { name, document: { version: 1, width: doc.width, height: doc.height, activeId: doc.activeId, layers } };
}

export function validProjectId(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}
