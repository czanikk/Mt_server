import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const server = createServer();
const wss = new WebSocketServer({ server });

// Room storage: roomCode -> { clients: Map<ws, userData>, leaderboard: [], ... }
const rooms = new Map();

// Helper to broadcast to all clients in a room except sender
function broadcastToRoom(roomCode, sender, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const [client, user] of room.clients) {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
}

// Send leaderboard update to all clients in a room
function updateLeaderboard(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const leaderboard = Array.from(room.clients.values())
    .map(u => ({
      userId: u.userId,
      name: u.name,
      studyTime: u.studyTime,
      isStudying: u.isStudying,
      sessionCount: u.sessionCount,
      distractionCount: u.distractionCount,
      longestSession: u.longestSession,
      currentSessionStart: u.currentSessionStart
    }));
  const message = { type: 'LEADERBOARD_UPDATE', leaderboard };
  for (const [client] of room.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
}

wss.on('connection', (ws) => {
  let currentRoomCode = null;
  let userData = null;

  ws.on('message', (raw) => {
    const data = JSON.parse(raw);
    console.log('Received:', data.type);

    switch (data.type) {
      case 'CREATE_ROOM': {
        // Generate a 6-character room code
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const room = {
          clients: new Map(),
        };
        rooms.set(roomCode, room);
        currentRoomCode = roomCode;

        userData = {
          userId: data.userId,
          name: data.userName,
          studyTime: data.existingStudyTime,
          isStudying: data.isCurrentlyStudying,
          sessionCount: data.sessionCount,
          distractionCount: 0,
          longestSession: data.longestSession,
          currentSessionStart: data.isCurrentlyStudying ? Date.now() : null
        };
        room.clients.set(ws, userData);

        ws.send(JSON.stringify({
          type: 'ROOM_CREATED',
          roomCode,
          leaderboard: Array.from(room.clients.values()).map(u => ({
            userId: u.userId,
            name: u.name,
            studyTime: u.studyTime,
            isStudying: u.isStudying,
            sessionCount: u.sessionCount,
            distractionCount: u.distractionCount,
            longestSession: u.longestSession,
            currentSessionStart: u.currentSessionStart
          }))
        }));
        break;
      }

      case 'JOIN_ROOM': {
        const roomCode = data.roomCode;
        const room = rooms.get(roomCode);
        if (!room) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found', errorCode: 'ROOM_NOT_FOUND' }));
          return;
        }

        currentRoomCode = roomCode;
        userData = {
          userId: data.userId,
          name: data.userName,
          studyTime: data.existingStudyTime,
          isStudying: data.isCurrentlyStudying,
          sessionCount: data.sessionCount,
          distractionCount: 0,
          longestSession: data.longestSession,
          currentSessionStart: data.isCurrentlyStudying ? Date.now() : null
        };
        room.clients.set(ws, userData);

        ws.send(JSON.stringify({
          type: 'ROOM_JOINED',
          roomCode,
          leaderboard: Array.from(room.clients.values()).map(u => ({
            userId: u.userId,
            name: u.name,
            studyTime: u.studyTime,
            isStudying: u.isStudying,
            sessionCount: u.sessionCount,
            distractionCount: u.distractionCount,
            longestSession: u.longestSession,
            currentSessionStart: u.currentSessionStart
          }))
        }));

        broadcastToRoom(roomCode, ws, { type: 'USER_JOINED', userName: data.userName });
        updateLeaderboard(roomCode);
        break;
      }

      case 'STUDY_STARTED': {
        if (!currentRoomCode || !userData) return;
        userData.isStudying = true;
        userData.currentSessionStart = Date.now();
        const room = rooms.get(currentRoomCode);
        if (room) {
          broadcastToRoom(currentRoomCode, ws, { type: 'COMPETITOR_STARTED', userName: userData.name });
          updateLeaderboard(currentRoomCode);
        }
        break;
      }

      case 'STUDY_STOPPED': {
        if (!currentRoomCode || !userData) return;
        userData.isStudying = false;
        if (userData.currentSessionStart) {
          const duration = (Date.now() - userData.currentSessionStart) / 1000;
          userData.studyTime += Math.floor(duration);
          userData.longestSession = Math.max(userData.longestSession, Math.floor(duration));
          userData.currentSessionStart = null;
        }
        if (data.wasDistraction) {
          userData.distractionCount++;
        }
        const room = rooms.get(currentRoomCode);
        if (room) {
          broadcastToRoom(currentRoomCode, ws, { type: 'COMPETITOR_STOPPED', userName: userData.name });
          updateLeaderboard(currentRoomCode);
        }
        break;
      }

      case 'DISTRACTION': {
        if (!currentRoomCode || !userData) return;
        userData.distractionCount++;
        const room = rooms.get(currentRoomCode);
        if (room) {
          broadcastToRoom(currentRoomCode, ws, { type: 'COMPETITOR_DISTRACTED', userName: userData.name, distractionCount: userData.distractionCount });
          updateLeaderboard(currentRoomCode);
        }
        break;
      }

      case 'SYNC': {
        if (!currentRoomCode || !userData) return;
        userData.studyTime = data.totalStudyTime;
        userData.isStudying = data.isStudying;
        userData.currentSessionStart = data.isStudying ? Date.now() : null;
        // No broadcast, just update local state
        updateLeaderboard(currentRoomCode);
        break;
      }

      case 'PING': {
        ws.send(JSON.stringify({ type: 'PONG' }));
        break;
      }

      default:
        console.log('Unknown message type:', data.type);
    }
  });

  ws.on('close', () => {
    if (currentRoomCode && userData) {
      const room = rooms.get(currentRoomCode);
      if (room) {
        room.clients.delete(ws);
        broadcastToRoom(currentRoomCode, null, { type: 'USER_DISCONNECTED', userName: userData.name });
        updateLeaderboard(currentRoomCode);
        if (room.clients.size === 0) {
          rooms.delete(currentRoomCode);
          console.log(`Room ${currentRoomCode} deleted (empty)`);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`WebSocket server listening on port ${PORT}`);
});