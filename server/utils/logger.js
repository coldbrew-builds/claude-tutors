const DEBUG = process.env.APP_DEBUG === 'true';

function timestamp() {
  return new Date().toISOString();
}

function format(level, tag, message, ...args) {
  const prefix = `[${timestamp()}] [${level}]${tag ? ` [${tag}]` : ''}`;
  if (args.length > 0) {
    console.log(prefix, message, ...args);
  } else {
    console.log(prefix, message);
  }
}

const logger = {
  info(tag, message, ...args) {
    format('INFO', tag, message, ...args);
  },
  debug(tag, message, ...args) {
    if (DEBUG) {
      format('DEBUG', tag, message, ...args);
    }
  },
  warn(tag, message, ...args) {
    format('WARN', tag, message, ...args);
  },
  error(tag, message, ...args) {
    format('ERROR', tag, message, ...args);
  }
};

module.exports = logger;
