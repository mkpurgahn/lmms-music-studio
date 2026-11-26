// Structured runtime logger for LMMS Music Studio MCP modules.
// Writes strictly to process.stderr (never process.stdout, which is reserved for MCP JSON-RPC).

export const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

export function resolveLogLevel(env = process.env) {
  const raw = String(env?.LMMS_LOG_LEVEL ?? 'info').trim().toLowerCase();
  return Object.hasOwn(LOG_LEVELS, raw) ? raw : 'info';
}

function serializeMetaValue(_key, value) {
  if (value instanceof Error) {
    return {
      error: value.message,
      ...(value.code !== undefined ? { code: value.code } : {}),
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function serializeMeta(meta) {
  if (meta === undefined || meta === null) return '';
  if (meta instanceof Error) {
    return JSON.stringify(serializeMetaValue('', meta));
  }
  if (typeof meta === 'object') {
    if (!Array.isArray(meta) && Object.keys(meta).length === 0) return '';
    try {
      return JSON.stringify(meta, serializeMetaValue);
    } catch {
      return JSON.stringify({ meta: '[unserializable]' });
    }
  }
  return JSON.stringify({ value: meta });
}

export function formatLogLine(level, component, message, meta, now = new Date()) {
  const iso = (now instanceof Date ? now : new Date(now)).toISOString();
  const normalizedLevel = String(level || 'info').toUpperCase();
  const normalizedComponent = String(component || 'app').replace(/[\r\n]+/g, ' ').trim() || 'app';
  const normalizedMessage = String(message ?? '').replace(/[\r\n]+/g, ' ').trim();
  const encodedMeta = serializeMeta(meta);
  return encodedMeta
    ? `[${iso}] [${normalizedLevel}] [${normalizedComponent}] ${normalizedMessage} ${encodedMeta}`
    : `[${iso}] [${normalizedLevel}] [${normalizedComponent}] ${normalizedMessage}`;
}

export function createLogger(component = 'app', { env = process.env, stream = process.stderr, now = () => new Date() } = {}) {
  if (stream === process.stdout) {
    throw new Error('MCP runtime logger must never write to process.stdout');
  }
  const targetStream = stream ?? process.stderr;
  const write = (level, message, meta) => {
    const threshold = LOG_LEVELS[resolveLogLevel(env)];
    if (LOG_LEVELS[level] < threshold) return false;
    const line = formatLogLine(level, component, message, meta, now());
    targetStream.write(line + '\n');
    return true;
  };
  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    child: subComponent => createLogger(`${component}:${subComponent}`, { env, stream: targetStream, now }),
  };
}
