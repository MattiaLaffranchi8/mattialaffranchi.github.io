// server.js - Backend del Gioco dell'Impostore

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Configurazione Socket.IO: Permette la comunicazione in tempo reale
// Cors: Permette al frontend (localhost:3000) di connettersi al backend (localhost:3000)
const io = new Server(server, {
    cors: {
        origin: "*", // Permetti connessioni da qualsiasi dominio (per semplicità)
        methods: ["GET", "POST"]
    }
});

// Serve i file statici (come index.html) dalla directory corrente
app.use(express.static(path.join(__dirname)));

// VARIABILI GLOBALI DEL GIOCO
const rooms = {}; // Struttura: { codiceStanza: { parola, stato, players: [], timerInterval } }
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 3;

// Lista delle parole (la stessa che avevi nel client)
const parole = [
    'casa', 'cane', 'albero', 'fiore', 'libro', 'tavolo', 'sedia', 'sole', 'luna', 'stella',
    'acqua', 'aria', 'terra', 'fuoco', 'pioggia', 'neve', 'gatto', 'topo', 'uccello', 'pesce',
    'pane', 'latte', 'zucchero', 'sale', 'frutta', 'verdura', 'scuola', 'lavoro', 'strada', 'città',
    'montagna', 'mare', 'fiume', 'ponte', 'auto', 'treno', 'aereo', 'nave', 'orologio', 'telefono',
    'gioco', 'musica', 'film', 'sport', 'amico', 'famiglia', 'tempo', 'denaro', 'carta', 'penna'
];

// --- UTILITY SERVER ---

/** Genera un codice alfanumerico di 4 lettere maiuscole. */
function generateUniqueCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 6).toUpperCase();
    } while (rooms[code]); // Assicura che non esista già
    return code;
}

/** Ottiene la lista dei giocatori pronta per essere inviata al client. */
function getPlayerList(roomCode) {
    return rooms[roomCode].players.map(p => ({
        id: p.id,
        nome: p.nome,
        isHost: p.isHost
    }));
}

// --- LOGICA DI GIOCO ---

/** Assegna i ruoli e la parola segreta. */
function initializeGame(room) {
    // 1. Scegli la parola segreta
    const randomIndex = Math.floor(Math.random() * parole.length);
    room.parola = parole[randomIndex].toUpperCase();
    
    // 2. Assegna i ruoli
    const numPlayers = room.players.length;
    let ruoli = Array(numPlayers).fill('Cittadino');
    for (let i = 0; i < room.numImpostori; i++) {
        ruoli[i] = 'Impostore';
    }
    
    // Mescola i ruoli
    for (let i = ruoli.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ruoli[i], ruoli[j]] = [ruoli[j], ruoli[i]];
    }

    // Mappa i ruoli ai giocatori
    room.players.forEach((player, index) => {
        player.ruolo = ruoli[index];
    });

    room.state = 'REVEAL';
    room.timer = 300; // 5 minuti
}

/** Gestisce il conto alla rovescia del gioco. */
function startRoomTimer(roomCode) {
    const room = rooms[roomCode];
    if (room.timerInterval) clearInterval(room.timerInterval);

    room.timerInterval = setInterval(() => {
        room.timer--;
        
        // Sincronizza il timer con tutti i client ogni secondo
        io.to(roomCode).emit('SYNC_TIMER', { timeRemaining: room.timer });

        if (room.timer <= 0) {
            clearInterval(room.timerInterval);
            room.timerInterval = null;
            
            // Forziamo la fine del gioco se il tempo scade
            endGame(roomCode, 'Impostori'); // Se il tempo finisce, vincono gli impostori (Simulazione)
        }
    }, 1000);
}

/** Termina la partita e invia i risultati. */
function endGame(roomCode, winningTeam) {
    const room = rooms[roomCode];
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.state = 'ENDED';

    const finalRoles = room.players.map(p => ({ nome: p.nome, ruolo: p.ruolo }));
    
    io.to(roomCode).emit('GAME_ENDED', {
        winningTeam: winningTeam,
        finalRoles: finalRoles
    });
    
    // Resetta lo stato per permettere una nuova partita senza distruggere la stanza
    room.parola = '';
    room.numImpostori = 0;
    room.timer = 300;
}


// --- GESTIONE CONNESSIONI (SOCKET.IO) ---

io.on('connection', (socket) => {
    console.log(`[CONN] Giocatore connesso: ${socket.id}`);

    // --- LOBBY: CREA STANZA ---
    socket.on('CREATE_ROOM', (data) => {
        if (!data.playerName) return socket.emit('ERROR', { message: 'Nome giocatore richiesto.' });

        const roomCode = generateUniqueCode();
        rooms[roomCode] = {
            parola: '',
            numImpostori: 0,
            state: 'LOBBY',
            timer: 300,
            players: [{ id: socket.id, nome: data.playerName, isHost: true }],
            timerInterval: null
        };

        socket.join(roomCode);
        console.log(`[ROOM] Stanza ${roomCode} creata da ${data.playerName}`);

        socket.emit('ROOM_CREATED', {
            roomCode: roomCode,
            playerId: socket.id,
            players: getPlayerList(roomCode)
        });
    });

    // --- LOBBY: UNISCITI A STANZA ---
    socket.on('JOIN_ROOM', (data) => {
        const roomCode = data.roomCode;
        const room = rooms[roomCode];
        
        if (!room) return socket.emit('ERROR', { message: 'Codice stanza non valido.' });
        if (room.state !== 'LOBBY') return socket.emit('ERROR', { message: 'Il gioco è già iniziato.' });
        if (room.players.length >= MAX_PLAYERS) return socket.emit('ERROR', { message: 'Stanza piena.' });
        if (!data.playerName) return socket.emit('ERROR', { message: 'Nome giocatore richiesto.' });

        socket.join(roomCode);
        
        // Aggiunge il giocatore alla stanza
        room.players.push({ id: socket.id, nome: data.playerName, isHost: false });
        console.log(`[JOIN] ${data.playerName} si è unito a ${roomCode}`);

        // Invia la conferma al nuovo client
        socket.emit('JOINED_ROOM', {
            roomCode: roomCode,
            playerId: socket.id,
            players: getPlayerList(roomCode)
        });

        // Notifica tutti i client nella stanza (incluso il nuovo)
        io.to(roomCode).emit('PLAYER_UPDATE', { players: getPlayerList(roomCode) });
    });
    
    // --- HOST: AVVIA GIOCO ---
    socket.on('START_GAME', (data) => {
        const roomCode = data.roomCode;
        const room = rooms[roomCode];
        
        // Validazione Host e Giocatori
        const host = room.players.find(p => p.id === socket.id && p.isHost);
        if (!host) return socket.emit('ERROR', { message: 'Solo l\'Host può avviare il gioco.' });
        if (room.players.length < MIN_PLAYERS) return socket.emit('ERROR', { message: `Servono almeno ${MIN_PLAYERS} giocatori.` });
        
        room.numImpostori = data.numImpostori;
        initializeGame(room);
        console.log(`[START] Gioco avviato in ${roomCode}. Parola: ${room.parola}`);

        // 1. Notifica a tutti che si passa alla fase di rivelazione
        io.to(roomCode).emit('PHASE_CHANGE', { phase: 'REVEAL' });

        // 2. Invia i dati segreti individualmente
        room.players.forEach(p => {
            io.to(p.id).emit('GAME_START', { 
                word: p.ruolo === 'Cittadino' ? room.parola : 'CRITICO', // L'impostore riceve una parola fittizia 'CRITICO'
                role: p.ruolo,
                players: getPlayerList(roomCode) 
            });
        });
        
        // Avvia il timer (inizierà dopo la fase di rivelazione)
        // In un gioco più complesso, il timer parte dopo che tutti i giocatori hanno cliccato "Accetta Ruolo"
        // Per semplicità, lo facciamo partire subito
        setTimeout(() => {
            room.state = 'DISCUSSION';
            io.to(roomCode).emit('PHASE_CHANGE', { phase: 'DISCUSSION' });
            startRoomTimer(roomCode);
            console.log(`[TIMER] Discussione iniziata in ${roomCode}`);
        }, 15000); // Dai 15 secondi per la rivelazione del ruolo
    });

    // --- GIOCO: RICHIESTA FINE DISCUSSIONE (Votazione) ---
    socket.on('REQUEST_VOTE', (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.state !== 'DISCUSSION') return;
        
        // Simula la vittoria dei cittadini
        endGame(data.roomCode, 'Cittadini');
        console.log(`[END] Votazione richiesta in ${data.roomCode}. Fine simulata.`);
    });


    // --- DISCONNESSIONE ---
    socket.on('disconnect', () => {
        let roomCode = null;
        let playerName = '';

        // Trova la stanza in cui si trovava il giocatore
        for (const code in rooms) {
            const index = rooms[code].players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                roomCode = code;
                playerName = rooms[code].players[index].nome;

                // Rimuovi il giocatore
                rooms[code].players.splice(index, 1);
                
                // Gestione Host
                if (rooms[code].players.length > 0 && index === 0) {
                    rooms[code].players[0].isHost = true; // Promuovi il prossimo in lista
                }
                
                // Se la stanza è vuota, eliminala
                if (rooms[code].players.length === 0) {
                    clearInterval(rooms[code].timerInterval);
                    delete rooms[code];
                    console.log(`[ROOM] Stanza ${roomCode} eliminata.`);
                } else {
                    // Notifica i giocatori rimasti
                    io.to(roomCode).emit('PLAYER_UPDATE', { players: getPlayerList(roomCode) });
                    if (rooms[code].players[0].isHost && rooms[code].state === 'LOBBY') {
                        io.to(rooms[code].players[0].id).emit('HOST_PROMOTED'); // Notifica il nuovo host (opzionale)
                    }
                }
                
                console.log(`[DISC] ${playerName} disconnesso da ${roomCode}`);
                break;
            }
        }
    });
});

// Avvia il server sulla porta 3000
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server Node.js in esecuzione su http://localhost:${PORT}`);
    console.log('Attendi la connessione dei client (apri index.html nel browser).');
});
