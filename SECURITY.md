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

- **Backup Your Recovery Key**: Store your account recovery key in a safe place
- **Export Your Identity**: Regularly export your identity in Settings → Info & Export
- **Use Strong Display Names**: While not required, use meaningful display names
- **Protect Your Invite Codes**: Don't share invite codes publicly

### Network Security

- **Use HTTPS/WSS**: When deploying signaling servers, use secure connections (wss://)
- **Firewall Configuration**: Only expose necessary ports (9001 for signaling)
- **VPN Usage**: Consider using a VPN for additional privacy
- **Local Network**: Be aware that P2P connections may expose your local IP

### Data Security

- **Local Storage**: Your identity and house keys are stored locally
- **Encryption**: House data is encrypted with symmetric keys
- **Data Directory**: Be aware of where your data is stored
  - Windows: `%APPDATA%\roommate\`
  - macOS: `~/Library/Application Support/roommate/`
  - Linux: `~/.config/roommate/`

### Signaling Server Security

If you're running your own signaling server:

- **Keep Updated**: Regularly update to the latest version
- **Access Control**: Consider implementing authentication for production
- **Rate Limiting**: Implement rate limiting to prevent abuse
- **Monitoring**: Monitor logs for suspicious activity
- **Backup**: Regularly backup server data

## Known Security Considerations

### Current Limitations

- **No Authentication**: The signaling server currently has no authentication
- **Public Invite Codes**: Invite codes are not cryptographically secure (they're opaque but predictable)
- **IP Exposure**: P2P connections may expose your local IP address to peers
- **No Message Encryption**: Voice is P2P but signaling messages are not encrypted (future: E2E encryption)

### Privacy Protections

- **Server Cannot Read Data**: The signaling server cannot read your user data. All house data, room content, and messages are encrypted and stored locally on your device
- **P2P Voice**: Voice communication is direct peer-to-peer (WebRTC) and never passes through the signaling server
- **Local Storage**: Your identity, house keys, and encrypted data are stored locally and never sent to the server
- **Server Role**: The signaling server only facilitates peer discovery, room metadata, and presence tracking - it does not have access to your encrypted content

### Future Security Enhancements

- End-to-end encrypted signaling messages
- Cryptographically secure invite codes
- Authentication for signaling servers
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
