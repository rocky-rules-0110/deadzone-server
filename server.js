// ═══════════════════════════════════════════════════════════════════════
// DEAD ZONE — Co-op Server
// Node.js + Socket.io
// Deploy on Railway: railway.app
// ═══════════════════════════════════════════════════════════════════════
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

const PORT = process.env.PORT || 3000;

// ── Party storage ─────────────────────────────────────────────────────
// parties[partyId] = {
//   id, hostSocket, hostName, mode, modeLabel,
//   guest: null | { socket, name },
//   pendingRequests: [{ socket, name }],
//   state: 'waiting' | 'playing' | 'closed',
//   gameState: { ... synced game data ... }
// }
const parties = new Map();

function generatePartyId() {
  return Math.random().toString(36).slice(2,8).toUpperCase();
}

function getPartyList() {
  const list = [];
  for (const [id, p] of parties) {
    if (p.state === 'waiting') {
      list.push({
        id,
        hostName:  p.hostName,
        mode:      p.mode,
        modeLabel: p.modeLabel,
        pending:   p.pendingRequests.length,
      });
    }
  }
  return list;
}

function broadcastPartyList() {
  io.emit('party_list', getPartyList());
}

// ── Connection handler ────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // ── CREATE PARTY ────────────────────────────────────────────────────
  socket.on('create_party', ({ username, mode, modeLabel }) => {
    // Clean up any existing party this socket owns
    for (const [id, p] of parties) {
      if (p.hostSocket === socket) { parties.delete(id); }
    }
    const partyId = generatePartyId();
    parties.set(partyId, {
      id:               partyId,
      hostSocket:       socket,
      hostName:         username,
      mode,
      modeLabel,
      guest:            null,
      pendingRequests:  [],
      state:            'waiting',
      gameState:        null,
    });
    socket.join(partyId);
    socket.emit('party_created', { partyId, hostName: username, mode, modeLabel });
    broadcastPartyList();
    console.log(`Party ${partyId} created by ${username} (${mode})`);
  });

  // ── GET PARTY LIST ──────────────────────────────────────────────────
  socket.on('get_parties', () => {
    socket.emit('party_list', getPartyList());
  });

  // ── REQUEST TO JOIN ─────────────────────────────────────────────────
  socket.on('request_join', ({ partyId, username }) => {
    const party = parties.get(partyId);
    if (!party) { socket.emit('join_error', 'Party not found.'); return; }
    if (party.state !== 'waiting') { socket.emit('join_error', 'Party is no longer available.'); return; }
    if (party.guest) { socket.emit('join_error', 'Party is full.'); return; }

    // Check not already pending
    const alreadyPending = party.pendingRequests.some(r => r.socket === socket);
    if (alreadyPending) { socket.emit('join_error', 'Request already pending.'); return; }

    party.pendingRequests.push({ socket, name: username });
    socket.emit('join_requested', { partyId, hostName: party.hostName });

    // Notify host
    party.hostSocket.emit('join_request', {
      partyId,
      requesterName: username,
      socketId:      socket.id,
      capacity:      party.guest ? 'Full' : '1/2',
    });
    console.log(`${username} requested to join party ${partyId}`);
  });

  // ── HOST APPROVES REQUEST ────────────────────────────────────────────
  socket.on('approve_join', ({ partyId, socketId }) => {
    const party = parties.get(partyId);
    if (!party || party.hostSocket !== socket) return;

    const reqIdx = party.pendingRequests.findIndex(r => r.socket.id === socketId);
    if (reqIdx === -1) return;

    const [req] = party.pendingRequests.splice(reqIdx, 1);

    // Decline all other pending requests
    party.pendingRequests.forEach(r => {
      r.socket.emit('join_declined', { partyId, reason: 'Party is now full.' });
    });
    party.pendingRequests = [];

    party.guest = { socket: req.socket, name: req.name };
    party.state = 'playing';
    req.socket.join(partyId);

    // Notify both players — game starts
    const startPayload = {
      partyId,
      hostName:  party.hostName,
      guestName: party.guest.name,
      mode:      party.mode,
      modeLabel: party.modeLabel,
      isHost:    false,
    };
    party.hostSocket.emit('game_start', { ...startPayload, isHost: true });
    req.socket.emit('game_start', { ...startPayload, isHost: false });

    broadcastPartyList();
    console.log(`Party ${partyId}: ${party.hostName} + ${party.guest.name} — GAME START`);
  });

  // ── HOST DECLINES REQUEST ────────────────────────────────────────────
  socket.on('decline_join', ({ partyId, socketId }) => {
    const party = parties.get(partyId);
    if (!party || party.hostSocket !== socket) return;

    const reqIdx = party.pendingRequests.findIndex(r => r.socket.id === socketId);
    if (reqIdx === -1) return;

    const [req] = party.pendingRequests.splice(reqIdx, 1);
    req.socket.emit('join_declined', { partyId, reason: 'The host declined your request.' });
    console.log(`Host declined ${req.name} from party ${partyId}`);
  });

  // ── CANCEL JOIN REQUEST ──────────────────────────────────────────────
  socket.on('cancel_join_request', ({ partyId }) => {
    const party = parties.get(partyId);
    if (!party) return;
    party.pendingRequests = party.pendingRequests.filter(r => r.socket !== socket);
    party.hostSocket.emit('join_request_cancelled', { socketId: socket.id });
  });

  // ── GAME STATE SYNC ──────────────────────────────────────────────────
  // Host sends authoritative game state; server relays to guest
  socket.on('host_state', ({ partyId, state }) => {
    const party = parties.get(partyId);
    if (!party || party.hostSocket !== socket || !party.guest) return;
    party.guest.socket.emit('host_state', state);
  });

  // Guest sends their player state; server relays to host
  socket.on('guest_state', ({ partyId, state }) => {
    const party = parties.get(partyId);
    if (!party || !party.guest || party.guest.socket !== socket) return;
    party.hostSocket.emit('guest_state', state);
  });

  // Relay events: bullet fired, zombie killed, damage taken, etc.
  socket.on('game_event', ({ partyId, event }) => {
    const party = parties.get(partyId);
    if (!party) return;
    // Broadcast to everyone else in the party room
    socket.to(partyId).emit('game_event', event);
  });

  // ── DISBAND / LEAVE PARTY ────────────────────────────────────────────
  socket.on('leave_party', ({ partyId }) => {
    handleLeave(socket, partyId);
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Find any party this socket was part of and handle leave
    for (const [id, party] of parties) {
      if (party.hostSocket === socket || (party.guest && party.guest.socket === socket)) {
        handleLeave(socket, id);
        break;
      }
      // Remove from pending requests
      party.pendingRequests = party.pendingRequests.filter(r => r.socket !== socket);
    }
  });

  function handleLeave(sock, partyId) {
    const party = parties.get(partyId);
    if (!party) return;

    if (party.hostSocket === sock) {
      // Host left — close party, notify guest
      if (party.guest) {
        party.guest.socket.emit('party_closed', { reason: 'The host left the game.' });
        party.guest.socket.leave(partyId);
      }
      party.pendingRequests.forEach(r => {
        r.socket.emit('join_declined', { partyId, reason: 'Party was closed.' });
      });
      parties.delete(partyId);
      console.log(`Party ${partyId} closed (host left)`);
    } else if (party.guest && party.guest.socket === sock) {
      // Guest left — notify host, party goes back to waiting
      party.hostSocket.emit('guest_left', { guestName: party.guest.name });
      party.guest.socket.leave(partyId);
      party.guest = null;
      party.state = 'waiting';
      console.log(`Guest left party ${partyId} — back to waiting`);
    }
    broadcastPartyList();
  }
});

// ── Health check ──────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('Dead Zone Co-op Server — Running ✓'));

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
