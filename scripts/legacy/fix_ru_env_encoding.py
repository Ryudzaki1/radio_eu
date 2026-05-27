import os

import paramiko


HOST = os.environ["RU_HOST"]
USER = os.environ.get("RU_USER", "radio")
KEY_PATH = os.environ["RU_KEY"]


def load_key(path):
    for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_cls.from_private_key_file(path)
        except paramiko.SSHException:
            continue
    raise RuntimeError("Could not read SSH key")


script = r"""
set -euo pipefail
cd /opt/radio_ru
python3 - <<'PY'
from pathlib import Path
p = Path(".env")
data = p.read_bytes()
if data.startswith(b"\xef\xbb\xbf"):
    data = data[3:]
data = data.replace(b"\r\n", b"\n")
p.write_bytes(data)
PY
docker compose up -d --force-recreate
sleep 5
head -n 3 .env | cat -vet
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
"""

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, pkey=load_key(KEY_PATH), look_for_keys=False, allow_agent=False)
try:
    stdin, stdout, stderr = client.exec_command("sudo -n bash -s", timeout=300)
    stdin.write(script)
    stdin.channel.shutdown_write()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    print(out.encode("ascii", errors="replace").decode("ascii"))
    if err:
        print(err.encode("ascii", errors="replace").decode("ascii"))
    code = stdout.channel.recv_exit_status()
    if code:
        raise SystemExit(code)
finally:
    client.close()
