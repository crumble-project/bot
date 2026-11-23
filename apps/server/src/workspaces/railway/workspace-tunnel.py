import os
import signal
import socket
import struct
import sys
import threading

OPEN, DATA, END = 1, 2, 3
HEADER = struct.Struct(">BII")
PID_FILE = "/run/crumble-workspace-tunnel.pid"

port = int(sys.argv[1])
out = sys.stdout.buffer
out_lock = threading.Lock()
connections = {}
connections_lock = threading.Lock()


def send(kind, connection, payload=b""):
    with out_lock:
        out.write(HEADER.pack(kind, connection, len(payload)) + payload)
        out.flush()


def listen():
    for _ in range(2):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            server.bind(("127.0.0.1", port))
            break
        except OSError:
            server.close()
            try:
                with open(PID_FILE) as file:
                    os.kill(int(file.read()), signal.SIGTERM)
            except (OSError, ValueError):
                pass
            threading.Event().wait(0.5)
    else:
        sys.exit(f"port {port} is taken")
    try:
        with open(PID_FILE, "w") as file:
            file.write(str(os.getpid()))
    except OSError:
        pass
    server.listen(64)
    return server


def finish(connection, direction):
    with connections_lock:
        entry = connections.get(connection)
        if entry is None:
            return
        entry[1].add(direction)
        if len(entry[1]) < 2:
            return
        del connections[connection]
    entry[0].close()


def pump(connection, client):
    try:
        while data := client.recv(65536):
            send(DATA, connection, data)
    except OSError:
        pass
    send(END, connection)
    finish(connection, "guest")


def accept(server):
    next_id = 0
    while True:
        client, _ = server.accept()
        next_id += 1
        with connections_lock:
            connections[next_id] = (client, set())
        send(OPEN, next_id)
        threading.Thread(target=pump, args=(next_id, client), daemon=True).start()


def read_exactly(size):
    data = b""
    while len(data) < size:
        chunk = os.read(0, size - len(data))
        if not chunk:
            return None
        data += chunk
    return data


threading.Thread(target=accept, args=(listen(),), daemon=True).start()

while header := read_exactly(HEADER.size):
    kind, connection, length = HEADER.unpack(header)
    payload = read_exactly(length) if length else b""
    if payload is None:
        break
    with connections_lock:
        entry = connections.get(connection)
    if entry is None:
        continue
    try:
        if kind == DATA:
            entry[0].sendall(payload)
        elif kind == END:
            entry[0].shutdown(socket.SHUT_WR)
    except OSError:
        pass
    if kind == END:
        finish(connection, "server")

os._exit(0)
