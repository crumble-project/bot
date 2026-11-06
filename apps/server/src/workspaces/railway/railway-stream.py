# Runs in a Railway sandbox as `python3 railway-stream.py <program> [args...]`. Railway delivers exec stdout as text,
# so the program's binary stdout goes out as one base64 line per read; stdin stays binary.
import base64
import os
import subprocess
import sys
import threading

child = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)


def pump_stdin():
    try:
        while data := os.read(0, 65536):
            child.stdin.write(data)
    except OSError:
        pass
    finally:
        try:
            child.stdin.close()
        except OSError:
            pass


threading.Thread(target=pump_stdin, daemon=True).start()

out = sys.stdout.buffer
while data := os.read(child.stdout.fileno(), 65536):
    out.write(base64.b64encode(data) + b"\n")
    out.flush()

sys.exit(child.wait())
