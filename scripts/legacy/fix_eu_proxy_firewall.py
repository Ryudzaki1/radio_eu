import os

import paramiko


HOST = os.environ["VPS_HOST"]
USER = os.environ.get("VPS_USER", "root")
PASSWORD = os.environ["VPS_PASS"]

COMMANDS = [
    "ufw allow in on wg0 to any port 18080 proto tcp || true",
    "systemctl restart caddy",
    "systemctl is-active caddy",
    "curl -I --max-time 10 http://10.77.0.1:18080/v1/voices || true",
    "ufw status verbose",
    "journalctl -u caddy -n 40 --no-pager",
]

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, look_for_keys=False, allow_agent=False)
try:
    for command in COMMANDS:
        print("--- " + command)
        _, stdout, stderr = client.exec_command(command, timeout=120)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        print(out.encode("ascii", errors="replace").decode("ascii"))
        if err:
            print(err.encode("ascii", errors="replace").decode("ascii"))
finally:
    client.close()
