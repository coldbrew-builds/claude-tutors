require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const logger = require('./utils/logger');
const LiveAIModule = require('./live-ai-module');

// Catch unhandled errors to diagnose socket drops
process.on('uncaughtException', (err) => {
  logger.error('Server', 'UNCAUGHT EXCEPTION:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Server', 'UNHANDLED REJECTION:', reason);
});

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// Serve client static files
app.use(express.static(path.join(__dirname, '..', 'client')));

// Serve generated tutorial images
app.use('/output', express.static(path.join(__dirname, '..', 'output')));

io.on('connection', (socket) => {
  logger.info('Server', `Client connected: ${socket.id} (transport=${socket.conn.transport.name})`);

  let module = new LiveAIModule();
  module.initialize(socket);

  socket.conn.on('upgrade', (transport) => {
    logger.info('Server', `Transport upgraded: ${transport.name} (${socket.id})`);
  });

  socket.on('stop_session', () => {
    logger.info('Server', `Client stopped session: ${socket.id}`);
    module.destroy();
    // Create a fresh module so the same socket can start a new session
    module = new LiveAIModule();
    module.initialize(socket);
  });

  socket.on('disconnect', (reason) => {
    logger.info('Server', `Client disconnected: ${socket.id} (reason=${reason})`);
    module.destroy();
  });

  socket.on('error', (err) => {
    logger.error('Server', `Socket error ${socket.id}:`, err.message);
  });
});

server.listen(PORT, () => {
  logger.info('Server', `Claude Tutors running on http://localhost:${PORT}`);
});
