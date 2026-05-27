import os

import paramiko


COMMANDS = [
    "ss -lntp | grep :443",
    "python3 -c 'import socket; s=socket.socket(); s.settimeout(2); print(s.connect_ex((\"127.0.0.1\",443)))'",
    "iptables -S ufw-user-input",
    "nft list ruleset | sed -n '1,180p'",
    "ip -4 addr show scope global",
]


client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(
    os.environ["VPS_HOST"],
    username=os.environ.get("VPS_USER", "root"),
    password=os.environ["VPS_PASS"],
    look_for_keys=False,
    allow_agent=False,
)

try:
    for command in COMMANDS:
        print("--- " + command)
        _, stdout, stderr = client.exec_command(command)
        print(stdout.read().decode("utf-8", errors="replace"))
        print(stderr.read().decode("utf-8", errors="replace"))
finally:
    client.close()
