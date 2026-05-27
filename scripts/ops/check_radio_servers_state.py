import os

import paramiko


RU_HOST = os.environ["RU_HOST"]
RU_USER = os.environ.get("RU_USER", "radio")
RU_KEY = os.environ["RU_KEY"]
EU_HOST = os.environ["EU_HOST"]
EU_USER = os.environ.get("EU_USER", "root")
EU_PASS = os.environ["EU_PASS"]


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


def check(client, label, commands):
    print(f"=== {label} ===")
    for command in commands:
        print("--- " + command)
        _, stdout, stderr = client.exec_command(command, timeout=120)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        print(out.encode("ascii", errors="replace").decode("ascii"))
        if err:
            print(err.encode("ascii", errors="replace").decode("ascii"))


ru = connect_key(RU_HOST, RU_USER, RU_KEY)
eu = connect_password(EU_HOST, EU_USER, EU_PASS)
try:
    check(ru, "RU", [
        "hostname",
        "git -C /opt/radio_ru status --short || true",
        "git -C /opt/radio_ru remote -v || true",
        "sudo -n ls -l /opt/radio_ru/.env || true",
        "sudo -n grep -E '^(PORT|PUBLIC_RADIO_URL|ELEVENLABS_BASE_URL)=' /opt/radio_ru/.env || true",
        "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' || true",
        "systemctl is-active caddy || true",
        "systemctl is-active wg-quick@wg0 || true",
        "ip -4 addr show wg0 || true",
    ])
    check(eu, "EU", [
        "hostname",
        "git -C /opt/radio_europa status --short || true",
        "git -C /opt/radio_europa remote -v || true",
        "ls -l /opt/radio_europa/.env || true",
        "grep -E '^(PORT|PUBLIC_RADIO_URL|ELEVENLABS_BASE_URL)=' /opt/radio_europa/.env || true",
        "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' || true",
        "systemctl is-active caddy || true",
        "systemctl is-active wg-quick@wg0 || true",
        "ip -4 addr show wg0 || true",
        "ss -lntup | grep -E ':(80|443|18080) ' || true",
    ])
finally:
    ru.close()
    eu.close()
