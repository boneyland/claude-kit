# Sends one command to mpv's IPC socket and prints its reply's data as JSON;
# exits 1 when mpv answers with an error. Other lines on the socket (events,
# replies to other requests) are skipped.
# Usage: python3 -I mpv-ipc.py <socket> <command as a JSON array>
import socket,sys,json
s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1])
s.sendall((json.dumps({"command":json.loads(sys.argv[2]),"request_id":7})+"\n").encode())
b=b""
while True:
  c=s.recv(65536)
  if not c: sys.exit(1)
  b+=c
  *lines,b=b.split(b"\n")
  for l in lines:
    d=json.loads(l or b"{}")
    if d.get("request_id")==7:
      print(json.dumps(d.get("data")))
      sys.exit(0 if d.get("error")=="success" else 1)
