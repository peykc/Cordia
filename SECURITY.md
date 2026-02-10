# Security Policy

## Supported Versions

We currently support the following versions with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via one of the following methods:

1. **Email**: Send details to [security@yourdomain.com] (replace with your actual security email)
2. **GitHub Security Advisory**: Use GitHub's private vulnerability reporting feature (if enabled)

### What to Include

When reporting a vulnerability, please include:

- **Description**: Clear description of the vulnerability
- **Steps to Reproduce**: Detailed steps to reproduce the issue
- **Impact**: Potential impact and severity
- **Suggested Fix**: If you have ideas for a fix (optional)
- **Affected Versions**: Which versions are affected

### Response Timeline

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Fix Timeline**: Depends on severity and complexity

### Disclosure Policy

- We will acknowledge receipt of your report within 48 hours
- We will keep you informed of our progress
- We will notify you when the vulnerability is fixed
- We will credit you in the security advisory (if you wish)

## Security Best Practices for Users

### Account Security

- **Backup your `.key` file**: Regularly export a backup `.key` file and store it in a safe place (Settings → Account / Info & Export)
- **Use Strong Display Names**: While not required, use meaningful display names
- **Protect Your Invite Codes**: Don't share invite codes publicly

### Network Security

- **Use HTTPS/WSS**: When deploying beacons, use secure connections (wss://)
- **Firewall Configuration**: Only expose necessary ports (9001 for beacon)
- **VPN Usage**: Consider using a VPN for additional privacy
- **Local Network**: Be aware that P2P connections may expose your local IP

### Data Security

- **Local Storage**: Your account data and server keys are stored locally
- **Encryption**: Server data is encrypted with symmetric keys
- **Data Directory**: Be aware of where your data is stored
  - Windows: `%APPDATA%\Cordia\`
  - macOS: `~/Library/Application Support/Cordia/`
  - Linux: `~/.config/cordia/`

### Beacon server security

If you're running your own beacon:

- **Keep Updated**: Regularly update to the latest version
- **Security options**: Use env vars to restrict CORS (`BEACON_CORS_ORIGINS`), cap request body size (`BEACON_MAX_BODY_BYTES`), and limit WebSocket connections (`BEACON_MAX_WS_CONNECTIONS`, `BEACON_MAX_WS_PER_IP`). See BEACON_SETUP.md → Security (beacon).
- **Access Control**: Consider implementing authentication for production (future enhancement)
- **Rate Limiting**: Additional per-IP rate limiting can be added; connection limits above help with resource exhaustion
- **Monitoring**: Monitor logs for suspicious activity
- **Backup**: Regularly backup server data

## Known Security Considerations

### Current Limitations

- **No Authentication**: The beacon has no user/auth; optional CORS, body size, and connection limits are available via env (see BEACON_SETUP.md)
- **Public Invite Codes**: Invite codes are not cryptographically secure (they're opaque but predictable)
- **IP Exposure**: P2P connections may expose your local IP address to peers
- **Ephemeral messaging (planned)**: text messaging is planned; message encryption and persistence are future work

### Privacy Protections

- **Voice is P2P**: voice communication is direct peer-to-peer (WebRTC) and never passes through the beacon
- **Sensitive server state is encrypted locally**: server state is encrypted client-side before it’s uploaded/synced
- **Local Storage**: Your account keys and encrypted server data are stored locally
- **Beacon role**: the beacon facilitates discovery/presence and some metadata sync; it should not have access to your encrypted server state

### Future Security Enhancements

- End-to-end encrypted beacon messages
- Cryptographically secure invite codes
- Authentication for beacons
- IP address privacy improvements
- Message authentication and integrity

## Security Updates

Security updates will be released as patch versions (e.g., 1.0.1, 1.0.2).

- **Critical**: Released as soon as possible
- **High**: Released within 7 days
- **Medium**: Released in next scheduled update
- **Low**: Included in next minor version

## Security Acknowledgments

We appreciate responsible disclosure. Contributors who report security vulnerabilities will be credited (if they wish) in security advisories.

## Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [WebRTC Security](https://webrtc.org/getting-started/overview)
- [Tauri Security](https://tauri.app/v1/guides/security/)

## Contact

For security-related questions or concerns, please use the methods listed in the "Reporting a Vulnerability" section above.
