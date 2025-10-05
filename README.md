# GNOME Display Brightness & Contrast using DDCUtil

This is a fork of [gnome-display-brightness-ddcutil](https://github.com/daitj/gnome-display-brightness-ddcutil) that adds support for **monitor contrast control** alongside brightness control.

## What's New in This Fork

### Contrast Control Features

In addition to all the original brightness control features, this fork adds:

- **Contrast sliders** for each external monitor (using DDC/CI VCP code 12)
- **Contrast indicator** in the system tray with scroll-to-adjust functionality
- **Keyboard shortcuts** for increasing/decreasing contrast
- **Auto-detection** of minimum contrast values (or manual configuration)
- **Per-monitor contrast control** that works alongside brightness control

## Installation

### Step 1: Install the Extension

Clone this repository into your GNOME Shell extensions directory:

```bash
git clone https://github.com/varunbpatil/display-brightness-ddcutil.git ~/.local/share/gnome-shell/extensions/display-brightness-ddcutil@varunbpatil
```

Then compile the settings schema:

```bash
cd ~/.local/share/gnome-shell/extensions/display-brightness-ddcutil@varunbpatil
glib-compile-schemas schemas/
```

### Step 2: Install ddcutil

This extension uses `ddcutil` as the backend for DDC/CI communication.

1. Install ddcutil:
   ```bash
   # Arch/Manjaro
   sudo pacman -S ddcutil

   # Ubuntu/Debian
   sudo apt install ddcutil

   # Fedora
   sudo dnf install ddcutil
   ```

2. Add your user to the `i2c` group:
   ```bash
   sudo usermod -aG i2c $USER
   ```

3. Load the i2c-dev kernel module:
   ```bash
   sudo modprobe i2c-dev
   ```

4. Make it persistent across reboots:
   ```bash
   echo "i2c-dev" | sudo tee /etc/modules-load.d/i2c-dev.conf
   ```

### Step 3: Enable the Extension

1. Log out and log back in (or restart GNOME Shell with `Alt+F2`, type `r`, and press Enter)
2. Open GNOME Extensions (or Extensions app)
3. Enable "Brightness control using ddcutil"

For detailed ddcutil setup and troubleshooting, see the [original repository](https://github.com/daitj/gnome-display-brightness-ddcutil).

## Contrast Control Settings

New settings specific to contrast control are available in the extension preferences:

### General Settings

- **Show Contrast Sliders** - Enable/disable contrast sliders for all monitors
- **Show Contrast Indicator** - Enable/disable contrast icon in system tray (allows scroll-to-adjust)

### Keyboard Shortcuts

- **Increase Contrast** - Default: `Shift+XF86MonBrightnessUp`
- **Decrease Contrast** - Default: `Shift+XF86MonBrightnessDown`
- **Step Change %** - Shared with brightness control (default: 2%)

### Advanced Settings

#### VCP Codes

- **VCP Code 12 (Contrast)** - Enable/disable contrast control via VCP code 12 (enabled by default)

#### Minimum Contrast Detection

Some monitors don't allow contrast to be set below a certain value (e.g., 25 instead of 0). This fork provides two ways to handle this:

1. **Auto-detect Minimum Contrast** (enabled by default)
   - Automatically detects your monitor's minimum contrast value on initialization
   - May cause a brief flicker when the extension loads
   - Ensures the slider accurately represents your monitor's actual contrast range

2. **Manual Minimum Contrast** (used when auto-detection is disabled)
   - Set the minimum contrast value manually (0-100)
   - No flicker on startup
   - Useful if you know your monitor's minimum value

**To configure:**
1. Open extension preferences
2. Go to **Advanced Settings**
3. To avoid flicker:
   - Disable "Auto-detect Minimum Contrast"
   - Set "Manual Minimum Contrast" to your monitor's minimum (find this by running `ddcutil setvcp 12 0` then `ddcutil getvcp 12`)

## Usage

### Contrast Sliders

When "Show Contrast Sliders" is enabled, you'll see contrast sliders appear below each monitor's brightness slider:

- **Monitor Name** (🌞) - Brightness control
- **Monitor Name (Contrast)** (🎨) - Contrast control

The contrast slider shows the actual contrast values your monitor supports (e.g., 25-100 instead of 0-100).

### Contrast Indicator

When "Show Contrast Indicator" is enabled, a contrast icon (🎨) appears in the system tray next to the brightness icon:

- **Scroll up** over the contrast icon to increase contrast for all monitors
- **Scroll down** over the contrast icon to decrease contrast for all monitors
- Works the same way as the brightness indicator's scroll functionality

### Keyboard Shortcuts

Use the keyboard shortcuts to quickly adjust contrast for all monitors simultaneously. The default shortcuts use Shift + brightness keys.

## How Contrast Values Work

- The slider position represents the normalized range (0% to 100%)
- The displayed value shows the actual contrast value (e.g., 25 to 100)
- Example with min=25, max=100:
  - Slider at 0% = Contrast 25
  - Slider at 50% = Contrast 62.5
  - Slider at 100% = Contrast 100

## Troubleshooting

### Contrast slider doesn't appear

1. Make sure "Show Contrast Sliders" is enabled in preferences
2. Check that "VCP Code 12" is enabled under Advanced Settings
3. Verify your monitor supports contrast control: `ddcutil getvcp 12`

### Slider shows wrong position

1. Try enabling "Auto-detect Minimum Contrast" in Advanced Settings
2. Or manually set the minimum contrast value (run `ddcutil setvcp 12 0 && ddcutil getvcp 12` to find it)

### Values don't persist after reboot

Make sure you've compiled the schema after installation:
```bash
cd ~/.local/share/gnome-shell/extensions/display-brightness-ddcutil@themightydeity.github.com
glib-compile-schemas schemas/
```

## Original Features

This fork maintains all original features:

- Brightness control via DDC/CI
- Support for multiple monitors
- Top bar or Quick Settings panel integration
- "All" slider to control all monitors simultaneously
- Internal display support
- Customizable keyboard shortcuts
- VCP code selection (10 or 6B for brightness)
- And more...

See the [original repository](https://github.com/daitj/gnome-display-brightness-ddcutil) for complete documentation of the base features.

## License

GPL-3.0 (same as the original project)

## Credits

- Original extension by [daitj](https://github.com/daitj/gnome-display-brightness-ddcutil)
