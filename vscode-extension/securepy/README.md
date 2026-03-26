# SecurePy - Static Security Analyzer for Python

A powerful, extensible static security analyzer for Python code. Detect security vulnerabilities, hardcoded secrets, and insecure patterns with configurable rules and minimal false positives.

## Requirements

## Requirements

SecurePy must be installed in a Python interpreter available to VS Code.

Recommended installation:

```bash
python3.12 -m pip install securepy
```

Optional:
- Set `securepy.executablePath` to a specific SecurePy executable path.

If `securepy.executablePath` is empty, the extension will try:
- the configured VS Code Python interpreter
- local virtual environments such as .venv
- common commands like python3.12, python3, and python


## Features

🔍 **10 Security Rules** - Comprehensive coverage of common vulnerabilities:
- **exec_eval** - Detect unsafe `exec()` and `eval()` usage
- **sql_injection** - Find SQL injection vulnerabilities  
- **path_traversal** - Identify unauthorized file access attempts
- **command_injection** - Detect OS command manipulation
- **unsafe_deserialization** - Find unsafe pickle/YAML operations
- **hardcoded_secret** - Locate hardcoded API keys and passwords
- **weak_crypto** - Identify weak cryptographic algorithms (MD5, SHA1)
- **debug_mode** - Detect debug mode enabled in production
- **insecure_tempfile** - Find insecure temporary file creation
- **assert_security** - Detect assertions used for security checks

📊 **Flexible Output** - Multiple report formats:
- Console output with colored severity levels
- JSON reports for CI/CD integration

⚙️ **Configurable Analysis**:
- Filter by severity level
- Adjust confidence thresholds
- Exclude specific directories
- Include specific file extensions
- Enable/disable individual rules

## Installation

### From Source
```bash
git clone https://github.com/rtl0019/securePy.git
cd securePy
pip install -e .
```

## Quick Start

### Basic Scan
```bash
securepy scan /path/to/your/project
```

### With Options
```bash
securepy scan . --min-severity high --format json --out report.json
```

## Usage

```bash
securepy scan [PATH] [OPTIONS]

Options:
  --format TEXT              Output format: console, json, or both
  --out TEXT                 Output file path
  --min-severity TEXT        Minimum severity: low, medium, high, critical
  --min-confidence TEXT      Minimum confidence: low, medium, high
  --exclude-dirs TEXT        Directories to exclude
  --include-ext TEXT         File extensions to include
  --rules TEXT               Specific rules to run
  --no-color                 Disable colored output
```

## Testing

```bash
pytest
```

## License

MIT License
