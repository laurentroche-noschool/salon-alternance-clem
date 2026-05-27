#!/usr/bin/env python3
"""Update VPS with latest code from GitHub"""
import paramiko
import os
os.environ['PYTHONIOENCODING'] = 'utf-8'

HOST = "51.77.223.57"
USER = "ubuntu"
PASS = "CrmParcoursup2026!"

def run_cmd(ssh, cmd, timeout=120):
    print(f">>> {cmd.strip()}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    output = stdout.read().decode('utf-8', errors='replace')
    errors = stderr.read().decode('utf-8', errors='replace')
    exit_code = stdout.channel.recv_exit_status()
    for line in output.strip().split('\n')[:20]:
        try: print(line)
        except: print(line.encode('ascii', 'replace').decode())
    if errors.strip() and exit_code != 0:
        try: print(f"STDERR: {errors.strip()[:200]}")
        except: pass
    return output, errors, exit_code

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=15)
print("Connecte au VPS!")

print("\n=== MISE A JOUR DU CODE ===")
run_cmd(ssh, "cd /opt/salon-alternance-clem && sudo git pull")

print("\n=== REDEMARRAGE DU SERVICE ===")
run_cmd(ssh, "sudo systemctl restart parcoursup-clem")

import time; time.sleep(3)
print("\n=== VERIFICATION ===")
run_cmd(ssh, "sudo systemctl is-active parcoursup")
run_cmd(ssh, "curl -s -o /dev/null -w 'HTTP %{http_code}' http://localhost:3012/parcoursup/")

print("\nMise a jour terminee! Dashboard disponible sur http://51.77.223.57:3012/parcoursup")
ssh.close()
