# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024

### Added

- **P2P Voice Chat**: Direct peer-to-peer WebRTC connections for low latency voice communication
- **Houses & Rooms**: Organize conversations with persistent spaces and room management
- **Real-time Presence**: Color-coded status indicators (online, active, in call)
- **Voice Activity Detection**: Visual indicators show who's speaking in real-time
- **Multi-Account Support**: Run multiple independent instances with separate data directories
- **Account Export/Import**: Backup and restore your identity and house keys
- **Per-Account Signaling Server**: Each account can use a different signaling server
- **Signaling Server**: Optional WebSocket server for peer discovery and room metadata
- **House Invites**: Share invite codes to let friends join your houses
- **Voice Participant Visibility**: See who's in voice calls in each room
- **Device Hot-Swapping**: Change audio devices without leaving calls
- **Voice Activation & Push-to-Talk**: Flexible audio input modes
- **Audio Settings UI**: Configure input/output devices, thresholds, and modes
- **Ed25519 Identity**: Cryptographic identity management
- **End-to-End Encryption**: Encrypted house data and communication
- **Graceful Degradation**: Works offline with reduced features
- **Modern UI**: Clean, brutalist design with dark mode
- **Resizable Sidebar**: Adjustable UserCard and room panel width
- **Room Name Truncation**: Smart text truncation to prevent layout shifts

### Changed

- Improved connection status indicators
- Enhanced presence tracking system
- Better error handling and user feedback
- Optimized audio processing pipeline
- Improved UI responsiveness

### Fixed

- Audio meter stream issues when rejoining calls
- Presence synchronization across rooms
- Voice participant cleanup on disconnect
- Account switching and signaling server reload
- House import duplicate prevention
- Symmetric key handling for invite redemption

### Security

- Secure key storage and encryption
- Per-account data isolation
- Secure invite code generation

## [Unreleased]

### Planned

- DHT mode (libp2p) for serverless peer discovery
- Text chat
- File sharing
- Mobile support
- Enhanced encryption features

[1.0.0]: https://github.com/Pey-K/Roommate/releases/tag/v1.0.0
