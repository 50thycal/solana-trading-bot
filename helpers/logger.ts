import pino from 'pino';

// Read LOG_FORMAT directly from env (logger loads before config-validator)
const logFormat = (process.env.LOG_FORMAT || 'pretty').toLowerCase();

const transport = logFormat === 'compact'
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: false,
        translateTime: 'HH:mm:ss',
        ignore: 'pid,hostname',
        singleLine: true,
        messageFormat: '{msg}',
      },
    })
  : pino.transport({
      target: 'pino-pretty',
    });

export const logger = pino(
  {
    level: 'info',
    redact: {
      paths: [
        'poolKeys',
        'privateKey', 'secretKey', 'secret',
        'apiKey', 'api_key', 'authorization',
        '*.privateKey', '*.secretKey', '*.secret',
        '*.apiKey', '*.api_key', '*.authorization',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      error: pino.stdSerializers.err,
    },
    base: undefined,
  },
  transport,
);
