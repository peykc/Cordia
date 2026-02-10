# Contributing to Cordia

Thank you for your interest in contributing to Cordia! This document provides guidelines and instructions for contributing.

## Getting Started

### Prerequisites

Before you begin, make sure you have:

- **Node.js** (v18 or higher)
- **Rust** (latest stable)
- **Docker** (optional - for running a local beacon)
- **Git**

See **[SETUP.md](SETUP.md)** for detailed platform-specific setup instructions.

### Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/Cordia.git
   cd Cordia
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start a local beacon (optional):**
   ```bash
   docker-compose up -d
   ```
   
   **Note:** You can also use the default beacon at `beacon.pkcollection.net` for development. No local server needed!

4. **Start the development server:**
   ```bash
   npm run tauri dev
   ```

See **[QUICKSTART.md](QUICKSTART.md)** for more detailed setup instructions.

## Development Workflow

### 1. Create a Branch

Create a new branch for your changes:

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 2. Make Your Changes

- Write clear, readable code
- Follow existing code style and patterns
- Add comments for complex logic
- Update documentation if needed

### 3. Test Your Changes

- Test locally with `npm run tauri dev`
- Test with multiple instances (use `launch1.bat` and `launch2.bat` for Windows)
- Verify the beacon server still works (if you changed it)
- Test edge cases and error handling

### 4. Commit Your Changes

Write clear, descriptive commit messages:

```bash
git add .
git commit -m "Add feature: description of what you added"
```

**Commit message guidelines:**
- Use present tense ("Add feature" not "Added feature")
- Keep the first line under 50 characters
- Add more details in the body if needed
- Reference issues if applicable: "Fix #123"

### 5. Push and Create Pull Request

```bash
git push origin feature/your-feature-name
```

Then create a pull request on GitHub with:
- Clear description of changes
- Screenshots if UI changes
- Reference to related issues

## Code Style

### TypeScript/React

- Use TypeScript for type safety
- Follow React best practices
- Use functional components with hooks
- Keep components small and focused
- Use meaningful variable and function names

### Rust

- Follow Rust naming conventions (snake_case for functions/variables, PascalCase for types)
- Use `Result` types for error handling
- Add documentation comments for public functions
- Keep functions focused and testable

### Formatting

- TypeScript: Use the project's ESLint/Prettier configuration
- Rust: Use `cargo fmt` to format code
- Rust: Use `cargo clippy` to check for common issues

## Project Structure

```
Cordia/
├── src/                    # React frontend
│   ├── components/         # Reusable UI components
│   ├── contexts/           # React contexts (state management)
│   ├── lib/                # Utilities and helpers
│   └── pages/              # Page components
├── src-tauri/              # Rust backend (Tauri)
│   └── src/
│       ├── identity.rs     # Cryptographic identity (stored locally)
│       ├── account_manager.rs  # Multi-account support
│       ├── server.rs       # Server data + encryption
│       └── main.rs         # Tauri commands
├── beacon-server/          # Beacon server (Axum + WebSocket)
│   └── src/                # Beacon implementation
└── deploy/                 # Deployment configurations
```

## Areas for Contribution

### Features

- UI/UX improvements
- New features (text chat, file sharing, etc.)
- Performance optimizations
- Mobile support
- DHT mode implementation

### Bug Fixes

- Check existing issues on GitHub
- Fix bugs and add tests
- Improve error handling

### Documentation

- Improve existing docs
- Add code comments
- Write tutorials
- Update README

### Testing

- Add unit tests
- Add integration tests
- Improve test coverage

## Pull Request Process

1. **Update your branch:**
   ```bash
   git checkout main
   git pull origin main
   git checkout your-branch
   git rebase main
   ```

2. **Ensure code quality:**
   - Code compiles without errors
   - No linter warnings
   - Follows project style
   - Tests pass (if applicable)

3. **Create PR:**
   - Clear title and description
   - Link to related issues
   - Add screenshots for UI changes
   - Request review from maintainers

4. **Respond to feedback:**
   - Address review comments
   - Make requested changes
   - Keep discussion constructive

## Code Review Guidelines

### For Contributors

- Be open to feedback
- Explain your design decisions
- Respond to comments promptly
- Keep PRs focused and small when possible

### For Reviewers

- Be constructive and respectful
- Explain reasoning for suggestions
- Approve when satisfied
- Test changes when possible

## Reporting Issues

When reporting bugs or requesting features:

1. **Check existing issues** to avoid duplicates
2. **Use the issue templates** if available
3. **Provide clear information:**
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment (OS, versions)
   - Screenshots if applicable

## Security Issues

**Do not** report security vulnerabilities publicly. Instead:

1. See **[SECURITY.md](SECURITY.md)** for reporting process
2. Email security issues privately
3. Wait for acknowledgment before disclosure

## Questions?

- Check existing documentation
- Search GitHub issues
- Ask in discussions (if enabled)
- Open an issue for clarification

## License

By contributing, you agree that your contributions will be licensed under the same license as the project (see [LICENSE](LICENSE)).

Thank you for contributing to Cordia! 🎉
