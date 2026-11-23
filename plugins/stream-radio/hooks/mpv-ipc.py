# Talks to mpv's IPC socket.
#
# python3 -I mpv-ipc.py <socket> <command as a JSON array>
#   Sends one command and prints its reply's data as JSON; exits 1 when mpv
#   answers with an error or nothing listens. Other lines on the socket
#   (events, replies to other requests) are skipped.
#
# python3 -I mpv-ipc.py <socket> --watch <property names as a JSON array>
#   Observes those properties and prints, one JSON object a line, each change
#   ({"event":"property-change","name":...,"data":...}) and the start, load
#   and end of each file, until mpv goes away (exit 0) or nothing listens
#   (exit 1). time-pos is printed in whole seconds and duration as whether
#   there is one (a live stream's grows all the time), each only when that
#   changes, so a playing file costs a line a second.
import socket,sys,json
try:
  s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sys.argv[1])
except OSError:
  sys.exit(1)
def lines():
  b=b""
  while True:
    try: c=s.recv(65536)
    except OSError: return
    if not c: return
    b+=c
    *ls,b=b.split(b"\n")
    for l in ls:
      if l:
        try: yield json.loads(l)
        except ValueError: pass
if sys.argv[2]=="--watch":
  props=json.loads(sys.argv[3])
  for i,p in enumerate(props):
    s.sendall((json.dumps({"command":["observe_property",i+1,p]})+"\n").encode())
  s.settimeout(None)
  keep={"property-change","start-file","file-loaded","end-file"}
  last={}
  try:
    for d in lines():
      ev=d.get("event")
      if ev not in keep: continue
      n=d.get("name")
      if ev=="property-change" and n in ("time-pos","duration"):
        t=d.get("data")
        if n=="duration": t=isinstance(t,(int,float))
        else: t=int(t) if isinstance(t,(int,float)) else None
        if n in last and last[n]==t: continue
        last[n]=t; d["data"]=t
      d.pop("id",None)
      print(json.dumps(d),flush=True)
  except BrokenPipeError:
    pass
  sys.exit(0)
s.sendall((json.dumps({"command":json.loads(sys.argv[2]),"request_id":7})+"\n").encode())
for d in lines():
  if d.get("request_id")==7:
    print(json.dumps(d.get("data")))
    sys.exit(0 if d.get("error")=="success" else 1)
sys.exit(1)
