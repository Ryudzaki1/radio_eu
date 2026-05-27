import os

import paramiko


host = os.environ["VPS_HOST"]
user = os.environ.get("VPS_USER", "root")
key_path = os.environ["VPS_KEY"]

for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
    try:
        key = key_cls.from_private_key_file(key_path)
        break
    except paramiko.SSHException:
        key = None
if key is None:
    raise RuntimeError("Could not read SSH private key")
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, username=user, pkey=key, look_for_keys=False, allow_agent=False)

try:
    commands = [
        "whoami",
        "hostname",
        "uname -a",
        "sudo -n true && echo SUDO_OK || echo SUDO_NO",
    ]
    for command in commands:
        print("--- " + command)
        _, stdout, stderr = client.exec_command(command)
        print(stdout.read().decode("utf-8", errors="replace"))
        err = stderr.read().decode("utf-8", errors="replace")
        if err:
            print(err)
finally:
    client.close()
