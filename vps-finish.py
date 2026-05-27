#!/usr/bin/env python3
"""Finish VPS installation - firewall + verification"""
import paramiko
import sys
import time
import os

os.environ['PYTHONIOENCODING'] = 'utf-8'

HOST = "51.77.223.57"
USER = "ubuntu"
PASS = "CrmParcoursup2026!"

def run_cmd(ssh, cmd, timeout=120):
    print(f"\n>>> {cmd.strip()}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    output = stdout.read().decode('utf-8', errors='replace')
    errors = stderr.read().decode('utf-8', errors='replace')
    exit_code = stdout.channel.recv_exit_status()
    # Safe print
    for line in output.strip().split('\n')[:30]:
        try:
            print(line)
        except UnicodeEncodeError:
            print(line.encode('ascii', 'replace').decode())
    if errors.strip() and exit_code != 0:
        for line in errors.strip().split('\n')[:5]:
            try:
                print(f"STDERR: {line}")
            except UnicodeEncodeError:
                print(f"STDERR: {line.encode('ascii', 'replace').decode()}")
    if exit_code != 0:
        print(f"EXIT CODE: {exit_code}")
    return output, errors, exit_code

def main():
    print(f"Connexion a {USER}@{HOST}...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASS, timeout=15)
    print("Connecte !")

    # Check service status
    print("\n=== STATUS DU SERVICE ===")
    run_cmd(ssh, "sudo systemctl is-active parcoursup")
    run_cmd(ssh, "sudo journalctl -u parcoursup-clem --no-pager -n 20 2>&1 | cat")

    # Firewall
    print("\n=== PARE-FEU ===")
    run_cmd(ssh, "sudo apt install -y ufw 2>&1 | tail -3")
    run_cmd(ssh, "sudo ufw allow 22/tcp")
    run_cmd(ssh, "sudo ufw allow 3012/tcp")
    run_cmd(ssh, "echo 'y' | sudo ufw enable")
    run_cmd(ssh, "sudo ufw status")

    # Test the app
    print("\n=== TEST APPLICATION ===")
    time.sleep(2)
    run_cmd(ssh, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3012/parcoursup/ 2>/dev/null || echo 'ERREUR'")
    run_cmd(ssh, "curl -s http://localhost:3012/parcoursup/api/health 2>/dev/null || echo 'Pas de health endpoint, test direct...'")
    run_cmd(ssh, "curl -s -o /dev/null -w 'HTTP %{http_code} - %{size_download} bytes' http://localhost:3012/parcoursup/ 2>/dev/null")

    print("\n" + "=" * 50)
    print("  INSTALLATION VPS TERMINEE !")
    print("=" * 50)
    print(f"\n  URL:  http://51.77.223.57:3012/parcoursup")
    print(f"  PIN:  CLEM2026")
    print(f"\n  SSH:  ssh ubuntu@51.77.223.57")
    print(f"  Pass: {PASS}")
    print(f"\n  Commandes utiles:")
    print(f"    Logs:       sudo journalctl -u parcoursup-clem -f")
    print(f"    Restart:    sudo systemctl restart parcoursup-clem")
    print(f"    Update:     cd /opt/salon-alternance-clem && sudo git pull && sudo systemctl restart parcoursup-clem")
    print("=" * 50)

    ssh.close()

if __name__ == "__main__":
    main()
