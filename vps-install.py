#!/usr/bin/env python3
"""SSH installer for CRM Parcoursup on OVH VPS - handles expired password"""
import paramiko
import sys
import time
import re

HOST = "51.77.223.57"
USER = "ubuntu"
OLD_PASS = "XhzDVrEbKhrt"
NEW_PASS = "CrmParcoursup2026!"  # New password after expiry

def wait_for_output(channel, timeout=10):
    """Wait for output on channel"""
    output = ""
    end_time = time.time() + timeout
    while time.time() < end_time:
        if channel.recv_ready():
            data = channel.recv(4096).decode('utf-8', errors='replace')
            output += data
            # Reset timeout when we get data
            end_time = time.time() + 2
        else:
            time.sleep(0.2)
    return output

def change_password(ssh):
    """Change expired password via interactive shell"""
    print("Changement du mot de passe expire...")
    transport = ssh.get_transport()
    channel = transport.open_session()
    channel.get_pty()
    channel.invoke_shell()

    # Wait for initial prompt
    time.sleep(2)
    output = wait_for_output(channel, 5)
    print(f"Initial: {output[-200:]}")

    # The system may ask for current password
    if "current" in output.lower() or "ancien" in output.lower() or "(current)" in output.lower():
        channel.send(OLD_PASS + "\n")
        time.sleep(1)
        output = wait_for_output(channel, 5)
        print(f"After current pass: {output[-200:]}")

    # New password
    if "new" in output.lower() or "nouveau" in output.lower():
        channel.send(NEW_PASS + "\n")
        time.sleep(1)
        output = wait_for_output(channel, 5)
        print(f"After new pass: {output[-200:]}")

    # Retype new password
    if "retype" in output.lower() or "again" in output.lower() or "nouveau" in output.lower() or "new" in output.lower():
        channel.send(NEW_PASS + "\n")
        time.sleep(2)
        output = wait_for_output(channel, 5)
        print(f"After confirm: {output[-200:]}")

    channel.close()
    return NEW_PASS

def run_cmd(ssh, cmd, timeout=300):
    """Run command via SSH"""
    print(f"\n>>> {cmd.strip()}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    output = stdout.read().decode('utf-8', errors='replace')
    errors = stderr.read().decode('utf-8', errors='replace')
    exit_code = stdout.channel.recv_exit_status()
    if output.strip():
        # Limit output length
        lines = output.strip().split('\n')
        if len(lines) > 30:
            print('\n'.join(lines[:10]))
            print(f"... ({len(lines)-20} lignes masquees) ...")
            print('\n'.join(lines[-10:]))
        else:
            print(output.strip())
    if errors.strip() and exit_code != 0:
        err_lines = errors.strip().split('\n')
        print(f"STDERR: {' | '.join(err_lines[:5])}")
    if exit_code != 0:
        print(f"EXIT CODE: {exit_code}")
    return output, errors, exit_code

def main():
    print(f"=== Connexion SSH a {USER}@{HOST} ===")

    # First connection - change password
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        ssh.connect(HOST, username=USER, password=OLD_PASS, timeout=15)
        print("Connecte (connexion initiale)")
    except Exception as e:
        print(f"Erreur de connexion: {e}")
        sys.exit(1)

    # Try a test command to see if password change is needed
    _, err, code = run_cmd(ssh, "echo test")
    if "password has expired" in err.lower() or code != 0:
        print("\n=== MOT DE PASSE EXPIRE - CHANGEMENT EN COURS ===")
        password = change_password(ssh)
        ssh.close()

        # Reconnect with new password
        time.sleep(2)
        print(f"\nReconnexion avec le nouveau mot de passe...")
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            ssh.connect(HOST, username=USER, password=NEW_PASS, timeout=15)
            out, err, code = run_cmd(ssh, "echo 'Connexion OK'")
            if code != 0:
                print("Le nouveau mot de passe ne fonctionne pas non plus.")
                print("Il faut changer le mot de passe manuellement via la console OVH.")
                ssh.close()
                sys.exit(1)
        except Exception as e:
            print(f"Erreur de reconnexion: {e}")
            print("Essai avec l'ancien mot de passe (peut-etre le changement a marche)...")
            try:
                ssh.connect(HOST, username=USER, password=OLD_PASS, timeout=15)
            except Exception as e2:
                print(f"Echec total: {e2}")
                sys.exit(1)

    print("Connexion SSH etablie !")

    # VERIFICATION SYSTEME
    print("\n=== VERIFICATION SYSTEME ===")
    run_cmd(ssh, "uname -a")
    run_cmd(ssh, "cat /etc/os-release | head -3")
    run_cmd(ssh, "free -h | head -2")
    run_cmd(ssh, "df -h / | tail -1")

    # INSTALLATION
    print("\n=== [1/7] MISE A JOUR SYSTEME ===")
    run_cmd(ssh, "sudo DEBIAN_FRONTEND=noninteractive apt update -y", timeout=120)
    run_cmd(ssh, "sudo DEBIAN_FRONTEND=noninteractive apt upgrade -y", timeout=300)

    print("\n=== [2/7] INSTALLATION NODE.JS 20 ===")
    run_cmd(ssh, "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -", timeout=60)
    run_cmd(ssh, "sudo apt install -y nodejs", timeout=120)
    run_cmd(ssh, "node --version && npm --version")

    print("\n=== [3/7] INSTALLATION CHROMIUM ===")
    run_cmd(ssh, "sudo apt install -y chromium || sudo apt install -y chromium-browser", timeout=180)
    out, _, _ = run_cmd(ssh, "which chromium 2>/dev/null || which chromium-browser 2>/dev/null || echo '/snap/bin/chromium'")
    chromium_path = out.strip().split('\n')[0] or "/usr/bin/chromium"
    print(f">>> Chromium path detecte: {chromium_path}")

    print("\n=== [4/7] INSTALLATION GIT ===")
    run_cmd(ssh, "sudo apt install -y git", timeout=60)

    print("\n=== [5/7] CLONAGE DU PROJET ===")
    run_cmd(ssh, "sudo rm -rf /opt/salon-alternance-clem 2>/dev/null; sudo git clone https://github.com/laurentroche-noschool/salon-alternance-clem.git /opt/salon-alternance-clem", timeout=60)

    print("\n=== [6/7] INSTALLATION NPM ===")
    run_cmd(ssh, "cd /opt/salon-alternance-clem && sudo npm install --production", timeout=180)
    run_cmd(ssh, "sudo mkdir -p /opt/salon-alternance-clem/data")

    print("\n=== [7/7] CONFIGURATION ===")
    # Create .env file
    run_cmd(ssh, """sudo tee /opt/salon-alternance-clem/.env.parcoursup > /dev/null << 'EOF'
PORT=3012
PARCOURSUP_PIN=CLEM2026
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=contact@clem-formation.fr
SMTP_PASS=pakc mmkn ojuu zrkq
SMTP_FROM_NAME=Service Admissions
EOF""")

    # Create systemd service
    run_cmd(ssh, f"""sudo tee /etc/systemd/system/parcoursup-clem.service > /dev/null << 'EOF'
[Unit]
Description=CRM Parcoursup
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/salon-alternance-clem
EnvironmentFile=/opt/salon-alternance-clem/.env.parcoursup
ExecStart=/usr/bin/node parcoursup-server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=PUPPETEER_EXECUTABLE_PATH={chromium_path}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF""")

    # Start service
    print("\n=== DEMARRAGE DU SERVICE ===")
    run_cmd(ssh, "sudo systemctl daemon-reload")
    run_cmd(ssh, "sudo systemctl enable parcoursup-clem")
    run_cmd(ssh, "sudo systemctl start parcoursup-clem")
    time.sleep(3)
    run_cmd(ssh, "sudo systemctl status parcoursup-clem --no-pager -l")

    # Firewall
    print("\n=== PARE-FEU ===")
    run_cmd(ssh, "sudo apt install -y ufw", timeout=60)
    run_cmd(ssh, "sudo ufw allow 22/tcp")
    run_cmd(ssh, "sudo ufw allow 3012/tcp")
    run_cmd(ssh, "echo 'y' | sudo ufw enable")
    run_cmd(ssh, "sudo ufw status")

    # Verification
    print("\n=== VERIFICATION FINALE ===")
    time.sleep(2)
    run_cmd(ssh, "curl -s http://localhost:3012/parcoursup/api/health 2>/dev/null || echo 'Checking logs...'")
    run_cmd(ssh, "sudo journalctl -u parcoursup-clem --no-pager -n 30")

    print("\n" + "=" * 50)
    print("  INSTALLATION TERMINEE !")
    print("=" * 50)
    print(f"\n  URL:  http://51.77.223.57:3012/parcoursup")
    print(f"  PIN:  CLEM2026")
    print(f"\n  SSH:  ssh ubuntu@51.77.223.57")
    print(f"  Pass: {NEW_PASS}")
    print(f"\n  Logs: sudo journalctl -u parcoursup-clem -f")
    print("=" * 50)

    ssh.close()

if __name__ == "__main__":
    main()
