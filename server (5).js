// ═══════════════════════════════════════════════════════════════════════
// DEAD ZONE — Co-op Server v3 (Host Authoritative)
// ═══════════════════════════════════════════════════════════════════════
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });
const PORT   = process.env.PORT || 3000;

// parties[partyId] = { id, hostSocket, hostName, mode, modeLabel,
//   guest:{socket,name}|null, pendingRequests:[{socket,name}],
//   state:'waiting'|'playing'|'closed' }
const parties = new Map();

function genId() { return Math.random().toString(36).slice(2,8).toUpperCase(); }

function partyList() {
  const list = [];
  for (const [id, p] of parties)
    if (p.state === 'waiting')
      list.push({ id, hostName:p.hostName, mode:p.mode, modeLabel:p.modeLabel });
  return list;
}
function broadcastList() { io.emit('party_list', partyList()); }

io.on('connection', socket => {
  console.log('connect', socket.id);

  // ── CREATE ──────────────────────────────────────────────────────────
  socket.on('create_party', ({ username, mode, modeLabel }) => {
    for (const [id,p] of parties) if (p.hostSocket===socket) parties.delete(id);
    const partyId = genId();
    const mapSeed = Math.floor(Math.random() * 2147483647);
    parties.set(partyId, {
      id:partyId, hostSocket:socket, hostName:username,
      mode, modeLabel, mapSeed,
      guest:null, pendingRequests:[], state:'waiting'
    });
    socket.join(partyId);
    socket.emit('party_created', { partyId, hostName:username, mode, modeLabel });
    broadcastList();
  });

  socket.on('get_parties', () => socket.emit('party_list', partyList()));

  // ── JOIN REQUEST ────────────────────────────────────────────────────
  socket.on('request_join', ({ partyId, username }) => {
    const p = parties.get(partyId);
    if (!p)              return socket.emit('join_error','Party not found.');
    if (p.state!=='waiting') return socket.emit('join_error','Party unavailable.');
    if (p.guest)         return socket.emit('join_error','Party is full.');
    if (p.pendingRequests.some(r=>r.socket===socket)) return;
    p.pendingRequests.push({ socket, name:username });
    socket.emit('join_requested', { partyId, hostName:p.hostName });
    p.hostSocket.emit('join_request', { partyId, requesterName:username, socketId:socket.id, capacity:'1/2' });
  });

  // ── APPROVE ─────────────────────────────────────────────────────────
  socket.on('approve_join', ({ partyId, socketId }) => {
    const p = parties.get(partyId);
    if (!p || p.hostSocket!==socket) return;
    const idx = p.pendingRequests.findIndex(r=>r.socket.id===socketId);
    if (idx===-1) return;
    const [req] = p.pendingRequests.splice(idx,1);
    p.pendingRequests.forEach(r=>r.socket.emit('join_declined',{partyId,reason:'Party is now full.'}));
    p.pendingRequests = [];
    p.guest = { socket:req.socket, name:req.name };
    p.state = 'playing';
    req.socket.join(partyId);
    const base = { partyId, hostName:p.hostName, guestName:p.guest.name, mode:p.mode, modeLabel:p.modeLabel, mapSeed:p.mapSeed };
    p.hostSocket.emit('game_start', { ...base, isHost:true });
    req.socket.emit('game_start',   { ...base, isHost:false });
    broadcastList();
    console.log(`Party ${partyId}: ${p.hostName} + ${p.guest.name} START`);
  });

  socket.on('decline_join', ({ partyId, socketId }) => {
    const p = parties.get(partyId);
    if (!p || p.hostSocket!==socket) return;
    const idx = p.pendingRequests.findIndex(r=>r.socket.id===socketId);
    if (idx===-1) return;
    const [req] = p.pendingRequests.splice(idx,1);
    req.socket.emit('join_declined',{partyId,reason:'Host declined your request.'});
  });

  socket.on('cancel_join_request', ({ partyId }) => {
    const p = parties.get(partyId);
    if (!p) return;
    p.pendingRequests = p.pendingRequests.filter(r=>r.socket!==socket);
    p.hostSocket.emit('join_request_cancelled',{socketId:socket.id});
  });

  // ── GAME DATA RELAY ─────────────────────────────────────────────────
  // Host → Guest: full game state at 20fps
  socket.on('host_state', ({ partyId, state }) => {
    const p = parties.get(partyId);
    if (!p || p.hostSocket!==socket || !p.guest) return;
    p.guest.socket.emit('host_state', state);
  });

  // Guest → Host: inputs every frame
  socket.on('guest_input', ({ partyId, input }) => {
    const p = parties.get(partyId);
    if (!p || !p.guest || p.guest.socket!==socket) return;
    p.hostSocket.emit('guest_input', { input });
  });

  // Guest → Host: discrete actions (mutation pick, open crafting, etc.)
  socket.on('guest_action', ({ partyId, action }) => {
    const p = parties.get(partyId);
    if (!p || !p.guest || p.guest.socket!==socket) return;
    p.hostSocket.emit('guest_action', { action });
  });

  // Host → Guest: action results (mutation granted, crafting result, etc.)
  socket.on('host_action', ({ partyId, action }) => {
    const p = parties.get(partyId);
    if (!p || p.hostSocket!==socket || !p.guest) return;
    p.guest.socket.emit('host_action', { action });
  });

  // ── ADMIN: force-delete a party ─────────────────────────────────────
  socket.on('admin_delete_party', ({ partyId, adminName }) => {
    if (adminName !== 'Admin') return; // only Admin account can do this
    const p = parties.get(partyId);
    if (!p) return;
    // Notify host and guest
    p.hostSocket.emit('party_closed', { reason: 'Party was removed by Admin.' });
    if (p.guest) p.guest.socket.emit('party_closed', { reason: 'Party was removed by Admin.' });
    p.pendingRequests.forEach(r => r.socket.emit('join_declined', { partyId, reason: 'Party was removed by Admin.' }));
    parties.delete(partyId);
    broadcastList();
    console.log(`Admin deleted party ${partyId}`);
  });

  // ── LEAVE / DISCONNECT ───────────────────────────────────────────────
  socket.on('leave_party', ({ partyId }) => handleLeave(socket, partyId));

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    for (const [id,p] of parties) {
      if (p.hostSocket===socket || (p.guest&&p.guest.socket===socket)) {
        handleLeave(socket, id); break;
      }
      p.pendingRequests = p.pendingRequests.filter(r=>r.socket!==socket);
    }
  });

  function handleLeave(sock, partyId) {
    const p = parties.get(partyId);
    if (!p) return;
    if (p.hostSocket===sock) {
      if (p.guest) { p.guest.socket.emit('party_closed',{reason:'Host left the game.'}); p.guest.socket.leave(partyId); }
      p.pendingRequests.forEach(r=>r.socket.emit('join_declined',{partyId,reason:'Party closed.'}));
      parties.delete(partyId);
      console.log(`Party ${partyId} closed (host left)`);
    } else if (p.guest&&p.guest.socket===sock) {
      p.hostSocket.emit('guest_left',{guestName:p.guest.name});
      p.guest.socket.leave(partyId);
      p.guest = null; p.state = 'waiting';
      console.log(`Guest left party ${partyId}`);
    }
    broadcastList();
  }
});

app.get('/', (_,res) => res.send('Dead Zone Co-op Server v3 ✓'));
server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
