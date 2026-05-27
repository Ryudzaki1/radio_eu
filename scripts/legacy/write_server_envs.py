import os
from pathlib import Path

import paramiko


RU_HOST = os.environ["RU_HOST"]
RU_USER = os.environ.get("RU_USER", "radio")
RU_KEY = os.environ["RU_KEY"]
EU_HOST = os.environ["EU_HOST"]
EU_USER = os.environ.get("EU_USER", "root")
EU_PASS = os.environ["EU_PASS"]
RU_PATH = os.environ.get("RU_PATH", "/opt/radio_ru/.env")
EU_PATH = os.environ.get("EU_PATH", "/opt/radio_europa/.env")
DOMAIN = os.environ.get("RADIO_DOMAIN", "radio.ryudzaki.website")
EU_PROXY_BASE = os.environ.get("EU_PROXY_BASE", "http://10.77.0.1:18080")


def load_key(path):
    for key_cls in (paramiko.Ed25519Key, paramiko.RSAKey, paramiko.ECDSAKey):
        try:
            return key_cls.from_private_key_file(path)
        except paramiko.SSHException:
            continue
    raise RuntimeError("Could not read SSH key")


def connect_key(host, user, key_path):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, pkey=load_key(key_path), look_for_keys=False, allow_agent=False)
    return client


def connect_password(host, user, password):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, look_for_keys=False, allow_agent=False)
    return client


def make_env(base, updates):
    lines = base.splitlines()
    seen = set()
    output = []
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line else ""
        if key in updates:
            output.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            output.append(line)
    for key, value in updates.items():
        if key not in seen:
            output.append(f"{key}={value}")
    return "\n".join(output) + "\n"


def sudo_write(client, path, content, owner=None):
    tmp = f"/tmp/codex-env-{os.getpid()}"
    sftp = client.open_sftp()
    with sftp.file(tmp, "w") as fh:
        fh.write(content)
    sftp.close()
    chown = f"chown {owner}:{owner} {path}" if owner else "true"
    command = f"sudo -n bash -lc 'install -m 600 {tmp} {path} && {chown} && rm -f {tmp}'"
    _, stdout, stderr = client.exec_command(command)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out:
        print(out)
    if err:
        print(err)
    if code:
        raise RuntimeError(f"failed to write {path}")


base = Path(".env").read_text(encoding="utf-8")
ru_env = make_env(base, {
    "PORT": "127.0.0.1:3000",
    "PUBLIC_RADIO_URL": f"https://{DOMAIN}",
    "ELEVENLABS_BASE_URL": EU_PROXY_BASE,
})
eu_env = make_env(base, {
    "PORT": "127.0.0.1:3001",
    "PUBLIC_RADIO_URL": f"https://{DOMAIN}",
})

ru = connect_key(RU_HOST, RU_USER, RU_KEY)
eu = connect_password(EU_HOST, EU_USER, EU_PASS)
try:
    sudo_write(ru, RU_PATH, ru_env, owner=RU_USER)
    sudo_write(eu, EU_PATH, eu_env)
    print("WROTE_ENV_FILES")
finally:
    ru.close()
    eu.close()
