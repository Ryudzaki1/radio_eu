import base64
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


client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, pkey=load_key(KEY_PATH), look_for_keys=False, allow_agent=False)

script = r"""
set -e
cd /opt/radio_ru
ADMIN_USERNAME="$(grep '^ADMIN_USERNAME=' .env | cut -d= -f2-)"
ADMIN_PASSWORD="$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2-)"
AUTH="$(printf '%s:%s' "$ADMIN_USERNAME" "$ADMIN_PASSWORD" | base64 -w0)"
echo "--- local home"
curl -I --max-time 10 http://127.0.0.1/
echo "--- elevenlabs proxy GET"
curl -sS --max-time 20 -H "xi-api-key: $(grep '^ELEVENLABS_API_KEY=' .env | cut -d= -f2-)" http://10.77.0.1:18080/v1/voices | head -c 300
echo
echo "--- app ai health"
curl -sS --max-time 30 -H "Authorization: Basic $AUTH" http://127.0.0.1/api/health/ai
echo
echo "--- wg"
wg show
"""

try:
    stdin, stdout, stderr = client.exec_command("sudo -n bash -s", timeout=120)
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
