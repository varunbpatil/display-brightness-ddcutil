/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

// menu items
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { loadInterfaceXML } from 'resource:///org/gnome/shell/misc/fileUtils.js';

import * as Convenience from './convenienceExt.js';
import * as Indicator from './indicator.js';

// for ui stuff of this extension
const QuickSettingsPanelMenuButton = Main.panel.statusArea.quickSettings;

const {
    StatusAreaBrightnessMenu,
    SystemMenuBrightnessMenu,
    StatusAreaContrastMenu,
    SystemMenuContrastMenu,
    SingleMonitorSliderAndValueForStatusAreaMenu,
    SingleMonitorSliderAndValueForQuickSettings,
    SingleMonitorSliderAndValueForQuickSettingsSubMenu,
} = Indicator;

const {
    brightnessLog,
    spawnWithCallback,
    getVCPInfoAsArray,
    isNullOrWhitespace
} = Convenience;

/*
    lowest possible value for brightness
    this is skipped if allow-zero-brightness is set
*/
const minBrightness = 1;
let displays = null;
let mainMenuButton = null;
let contrastMenuButton = null;
let writeCollection = null;
let _reloadMenuWidgetsTimer = null;
let _reloadExtensionTimer = null;
let reloadingExtension = false;
let monitorChangeTimeout = null;
let settingsSignals = {};
let oldSettings = null;
let monitorSignals = {};

let syncing = false
let pause_sync = false
let internal_control = true

/*
    instead of reading i2c bus everytime during startup,
    as it is unlikely that bus number changes, we can read
    cache file instead.
    one can make this file by running following shell command:
    ddcutil --brief detect > $XDG_CACHE_HOME/ddcutil_detect
*/
const cacheDir = GLib.get_user_cache_dir();
const ddcutilDetectCacheFile = `${cacheDir}/ddcutil_detect`;

const BUS_NAME = 'org.gnome.SettingsDaemon.Power';
const OBJECT_PATH = '/org/gnome/SettingsDaemon/Power';

const BrightnessInterface = loadInterfaceXML('org.gnome.Shell.Brightness');
const BrightnessProxy = Gio.DBusProxy.makeProxyWrapper(BrightnessInterface);

export default class DDCUtilBrightnessControlExtension extends Extension {
    enable() {
        this.settings = this.getSettings();
        this.enableBrightnessControl();
    }

    disable() {
        this.disableBrightnessControl();
        this.settings = null;
    }

    enableBrightnessControl() {
        displays = [];
        writeCollection = {};
        if (this.settings.get_int('button-location') === 0) {
            brightnessLog(this.settings, 'Adding to panel');
            mainMenuButton = new StatusAreaBrightnessMenu(this.settings);
            Main.panel.addToStatusArea('DDCUtilBrightnessSlider', mainMenuButton, 0, 'right');
            if (this.settings.get_boolean('show-contrast-indicator')) {
                brightnessLog(this.settings, 'Adding contrast to panel');
                contrastMenuButton = new StatusAreaContrastMenu(this.settings);
                Main.panel.addToStatusArea('DDCUtilContrastSlider', contrastMenuButton, 1, 'right');
                contrastMenuButton.connect('value-up', (actor, stepChange) => this.adjustAllContrast(stepChange));
                contrastMenuButton.connect('value-down', (actor, stepChange) => this.adjustAllContrast(-stepChange));
            }
        } else {
            brightnessLog(this.settings, 'Adding to system menu');
            mainMenuButton = new SystemMenuBrightnessMenu(this.settings);
            QuickSettingsPanelMenuButton._indicators.insert_child_at_index(mainMenuButton, this.settings.get_double('position-system-indicator'));
            if (this.settings.get_boolean('show-contrast-indicator')) {
                brightnessLog(this.settings, 'Adding contrast to system menu');
                contrastMenuButton = new SystemMenuContrastMenu(this.settings);
                QuickSettingsPanelMenuButton._indicators.insert_child_at_index(contrastMenuButton, this.settings.get_double('position-system-indicator') + 1);
                contrastMenuButton.connect('value-up', (actor, stepChange) => this.adjustAllContrast(stepChange));
                contrastMenuButton.connect('value-down', (actor, stepChange) => this.adjustAllContrast(-stepChange));
            }
        }
        if (mainMenuButton !== null) {
            /* connect all signals */
            this.connectSettingsSignals();
            this.connectMonitorChangeSignals();

            this.addKeyboardShortcuts();

            if (this.settings.get_int('button-location') === 0) {
                this.addTextItemToPanel(_('Initializing'));
                this.addSettingsItem();
            }

            this.addAllDisplaysToPanel().then();
        }
    }

    disableBrightnessControl() {
        /* disconnect all signals */
        this.disconnectSettingsSignals();
        this.disconnectMonitorSignals();

        /* remove shortcuts */
        this.removeKeyboardShortcuts();

        /* clear timeouts */
        if (_reloadMenuWidgetsTimer)
            clearTimeout(_reloadMenuWidgetsTimer);

        if (_reloadExtensionTimer)
            clearTimeout(_reloadExtensionTimer);

        Object.keys(writeCollection).forEach(bus => {
            if (writeCollection[bus].interval !== null) {
                clearInterval(writeCollection[bus].interval);
            }
        });
        if (monitorChangeTimeout !== null) {
            clearTimeout(monitorChangeTimeout)
            monitorChangeTimeout = null;
        }

        /* clear variables */
        mainMenuButton.destroy();
        mainMenuButton = null;
        if (contrastMenuButton !== null) {
            contrastMenuButton.destroy();
            contrastMenuButton = null;
        }
        displays = null;
        writeCollection = null;
    }

    ddcWriteCollector(displayBus, writer) {
        const kickoffNext = (reason) => {
            brightnessLog(this.settings, `kickoffNext called ${reason}`);
            writeCollection[displayBus].current = writeCollection[displayBus].next;
            writeCollection[displayBus].next = null;
            if (writeCollection[displayBus].current) {
                writeCollection[displayBus].current(() => {
                    if (writeCollection === null) {
                        // Must be disabling. Do nothing.
                        return;
                    }
                    kickoffNext("on chain");
                });
            } else {
                brightnessLog(this.settings, "writer done, nothing next");
            }
        }

        if (displayBus in writeCollection) {
            writeCollection[displayBus].next = writer;
            if (writeCollection[displayBus].current) {
                brightnessLog(this.settings, "Saving writer for when ready");
            } else {
                kickoffNext("on start");
            }
            return;
        }
        writeCollection[displayBus] = {
            next: writer,
            current: null
        };
        kickoffNext("on start");
    }

    setBrightness(display, newValue) {
        if (display.bus === 'internal') {
            this.setInternalBrightness(newValue);
            return;
        }
        let newBrightness = parseInt((newValue / 100) * display.max);
        if (newBrightness === 0) {
            if (!this.settings.get_boolean('allow-zero-brightness'))
                newBrightness = minBrightness;
        }
        const ddcutilPath = this.settings.get_string('ddcutil-binary-path');
        const ddcutilAdditionalArgs = this.settings.get_string('ddcutil-additional-args');
        const sleepMultiplier = this.settings.get_double('ddcutil-sleep-multiplier') / 40;
        const writer = async (ondone) => {
            const cmd = `${ddcutilPath} setvcp ${display.vcp} ${newBrightness} --bus ${display.bus} --sleep-multiplier ${sleepMultiplier} ${ddcutilAdditionalArgs}`.split(" ").filter(x => x !== "");
            brightnessLog(this.settings, `async ${cmd.join(" ")}`);
            await spawnWithCallback(this.settings, cmd, async (result) => {if (ondone) {await ondone();}});
        };
        brightnessLog(this.settings, `display ${display.name}, current: ${display.current} => ${newValue / 100}, new brightness: ${newBrightness}, new value: ${newValue}`);
        display.current = newValue / 100;

        this.ddcWriteCollector(display.bus, writer);
    }

    setInternalBrightness(newValue) {
        if (!internal_control)
            return
        let proxy = new BrightnessProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH)
        proxy.Brightness = newValue
    }

    setContrast(display, newValue) {
        /* newValue is an actual contrast value within [minContrast, maxContrast] */
        if (display.bus === 'internal' || !display.contrastEnabled)
            return;
        const range = display.maxContrast - display.minContrast;
        if (range <= 0)
            return;
        const newContrast = Math.min(display.maxContrast, Math.max(display.minContrast, Math.round(newValue)));
        const ddcutilPath = this.settings.get_string('ddcutil-binary-path');
        const ddcutilAdditionalArgs = this.settings.get_string('ddcutil-additional-args');
        const sleepMultiplier = this.settings.get_double('ddcutil-sleep-multiplier') / 40;
        const writer = async (ondone) => {
            const cmd = `${ddcutilPath} setvcp 12 ${newContrast} --bus ${display.bus} --sleep-multiplier ${sleepMultiplier} ${ddcutilAdditionalArgs}`.split(" ").filter(x => x !== "");
            brightnessLog(this.settings, `async ${cmd.join(" ")}`);
            await spawnWithCallback(this.settings, cmd, async (result) => {
                if (result.trim() !== '') {
                    /*
                        Some displays refuse contrast values below their own
                        minimum. ddcutil reports that as an error, but this is
                        expected: quietly recalibrate the floor instead of
                        surfacing an error.
                    */
                    brightnessLog(this.settings, `setvcp 12 ${newContrast} refused by ${display.name} (${display.bus}): ${result.trim()}`);
                    await this.recalibrateContrastFloor(display, newContrast);
                }
                if (ondone) {
                    await ondone();
                }
            });
        };
        brightnessLog(this.settings, `display ${display.name}, current contrast: ${display.currentContrast} => ${newContrast}`);
        display.currentContrast = (newContrast - display.minContrast) / range;
        this.ddcWriteCollector(display.bus, writer);
    }

    async fetchContrastValue(display) {
        brightnessLog(this.settings, `Fetching contrast for ${display.name} (${display.bus})`);
        await this.ddcutilCommandLine('12', display.bus, async ddcutilResponse => {
            if (this.displayValidate(ddcutilResponse) && !this.displayResponseError(ddcutilResponse)) {
                const ddcutilResponseArray = getVCPInfoAsArray(ddcutilResponse);
                if (ddcutilResponseArray.length >= 5) {
                    const current = parseInt(ddcutilResponseArray[3]);
                    const max = parseInt(ddcutilResponseArray[4]);
                    if (Number.isInteger(current) && Number.isInteger(max) && max > 0) {
                        const min = Math.min(Math.max(this.settings.get_double('contrast-min'), 0), max);
                        display.minContrast = min;
                        display.maxContrast = max;
                        display.contrastEnabled = true;
                        display.currentContrast = Math.min(1, Math.max(0, (current - min) / (max - min)));
                        brightnessLog(this.settings, `Contrast for ${display.name}: min=${min}, max=${max}, current=${current}`);
                    }
                }
            }
            this.reloadMenuWidgets();
        });
    }

    async recalibrateContrastFloor(display, attemptedValue) {
        /*
            Read back the contrast value the display actually settled on after
            refusing our write. If it is above what we asked for, the display
            has a minimum that is higher than our current floor, so raise the
            floor to the value it accepted. Nothing here is treated as an error.
        */
        await this.ddcutilCommandLine('12', display.bus, async ddcutilResponse => {
            if (this.displayValidate(ddcutilResponse) && !this.displayResponseError(ddcutilResponse)) {
                const ddcutilResponseArray = getVCPInfoAsArray(ddcutilResponse);
                if (ddcutilResponseArray.length >= 5) {
                    const current = parseInt(ddcutilResponseArray[3]);
                    if (Number.isInteger(current) && current > attemptedValue && current <= display.maxContrast) {
                        display.minContrast = current;
                        display.currentContrast = 0;
                        brightnessLog(this.settings, `Recalibrated minimum contrast for ${display.name} (${display.bus}) to ${current}`);
                        if (display.contrastSlider)
                            display.contrastSlider.changeValue(0);
                    }
                }
            }
        });
    }

    adjustAllContrast(deltaNorm) {
        /*
            Adjust the contrast of every external display by deltaNorm
            (a normalized 0-1 fraction). Used by the contrast indicator
            and keyboard shortcuts.
        */
        displays.forEach(display => {
            if (display.bus === 'internal' || !display.contrastEnabled)
                return;
            const slider = display.contrastSlider;
            const currentNorm = slider ? slider.ValueSlider.value : display.currentContrast;
            const nextNorm = Math.min(1, Math.max(0, currentNorm + deltaNorm));
            if (slider) {
                /* changing the slider value triggers the slider-change handler
                   which in turn calls setContrast */
                slider.setShowOSD();
                slider.changeValue(nextNorm * 100);
                slider.resetOSD();
            } else {
                const actual = Math.round(display.minContrast + nextNorm * (display.maxContrast - display.minContrast));
                this.setContrast(display, actual);
            }
        });
    }

    syncAllSlider() {
        if (pause_sync)
            return
        syncing = true
        if (this.settings.get_boolean('show-all-slider')) {
            var sum = 0.0
            for (let display of displays) {
                sum = sum + display.slider.ValueSlider.value
            }
            mainMenuButton.getStoredSliders()[0].changeValue(sum * 100 / displays.length)
            mainMenuButton.getStoredSliders()[0].old_value = sum * 100 / displays.length;
        }
        syncing = false
    }

    setAllBrightness(newValue) {

        if (syncing)
            return
        pause_sync = true
        const mode = "experimental"
        if (mode === "original") {
            displays.forEach(display => {
                display.slider.setHideOSD();
                display.slider.changeValue(newValue);
                display.slider.resetOSD();
            });
        } else if (mode === "experimental") {
            const oldValue = mainMenuButton.getStoredSliders()[0].old_value;

            if (oldValue === newValue)
                return;
            const increased = (newValue > oldValue)

            if (increased) {
                const increase = newValue - oldValue
                const remaining = 100 - oldValue
                const frac = increase / remaining
                displays.forEach(display => {
                    display.slider.setHideOSD();
                    const oldValue = 100 * display.slider.ValueSlider.value;
                    const remaining = 100 - oldValue
                    const increase = frac * remaining
                    display.slider.changeValue(oldValue + increase);
                    display.slider.resetOSD();
                });
            } else {
                const decrease = oldValue - newValue
                const remaining = oldValue
                const frac = decrease / remaining
                displays.forEach(display => {
                    display.slider.setHideOSD();
                    const oldValue = 100 * display.slider.ValueSlider.value;
                    const remaining = oldValue
                    const decrease = frac * remaining
                    display.slider.changeValue(oldValue - decrease);
                    display.slider.resetOSD();
                });
            }

            mainMenuButton.getStoredSliders()[0].old_value = newValue;
        }
        pause_sync = false
    }

    addSettingsItem() {
        const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        settingsItem.connect('activate', () => {
            this.openPreferences();
        });
        if (this.settings.get_int('button-location') === 0) {
            mainMenuButton.addMenuItem(settingsItem, 1);
        } else if (this.settings.get_boolean('show-sliders-in-submenu') && this.settings.get_boolean('show-all-slider')) {
            mainMenuButton.getStoredSliders()[0].menu.addMenuItem(settingsItem)
        }
        const reloadItem = new PopupMenu.PopupMenuItem(_('Reload'));
        reloadItem.connect('activate', event => {
            this.reloadExtension();
        });
        if (this.settings.get_int('button-location') === 0) {
            mainMenuButton.addMenuItem(reloadItem, 2);
        } else if (this.settings.get_boolean('show-sliders-in-submenu') && this.settings.get_boolean('show-all-slider')) {
            mainMenuButton.getStoredSliders()[0].menu.addMenuItem(reloadItem)
        }
    }

    addAllSlider() {
        const onAllSliderChange = (quickSettingsSlider, newValue) => {
            this.setAllBrightness(newValue);
        };
        let allslider = null;
        if (this.settings.get_int('button-location') === 0) {
            allslider = new SingleMonitorSliderAndValueForStatusAreaMenu(this.settings, _('All'), displays[0].current, onAllSliderChange);
        } else {
            allslider = new SingleMonitorSliderAndValueForQuickSettings({
                settings: this.settings,
                'display-name': _('All'),
                'current-value': displays[0].current,
            });
            allslider.connect('slider-change', onAllSliderChange);
            if (this.settings.get_boolean('show-sliders-in-submenu'))
                allslider.menuEnabled = true
            allslider.menu.setHeader('display-brightness-symbolic', 'Brightness');
        }
        mainMenuButton.addMenuItem(allslider);

        /* save slider in main menu, so that it can be accessed easily for different events */
        mainMenuButton.storeSliderForEvents(allslider);
    }

    addDisplayToPanel(display) {
        const onSliderChange = (quickSettingsSlider, newValue) => {
            this.setBrightness(display, newValue);
            this.syncAllSlider();
        };
        let displaySlider = null;
        if (this.settings.get_int('button-location') === 0) {
            displaySlider = new SingleMonitorSliderAndValueForStatusAreaMenu(this.settings, display.name, display.current, onSliderChange);
        } else if (this.settings.get_boolean('show-sliders-in-submenu')) {
            displaySlider = new SingleMonitorSliderAndValueForQuickSettingsSubMenu({
                settings: this.settings,
                'display-name': display.name,
                'current-value': display.current
            });
            displaySlider.connect('slider-change', onSliderChange);
        } else {
            displaySlider = new SingleMonitorSliderAndValueForQuickSettings({
                settings: this.settings,
                'display-name': display.name,
                'current-value': display.current,
            });
            displaySlider.connect('slider-change', onSliderChange);
        }

        display.slider = displaySlider;
        if (!(this.settings.get_boolean('show-all-slider') && this.settings.get_boolean('only-all-slider')))
            if (this.settings.get_boolean('show-sliders-in-submenu') && this.settings.get_boolean('show-all-slider')) {
                mainMenuButton.getStoredSliders()[0].menu.addMenuItem(displaySlider)
            } else {
                mainMenuButton.addMenuItem(displaySlider);
            }

        if (display.bus === 'internal') {
            const sync = () => {
                internal_control = false
                displaySlider.changeValue(display.proxy.Brightness)
                internal_control = true
            }
            display.proxy = new BrightnessProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
                (_proxy, error) => {
                    if (error)
                        console.error(error.message);
                    else
                        display.proxy.connect('g-properties-changed', () => sync());
                    sync();
                });
        }

        /* when "All" slider is shown we do not need to store each display's value slider */
        /* save slider in main menu, so that it can be accessed easily for different events */
        if (!this.settings.get_boolean('show-all-slider'))
            mainMenuButton.storeSliderForEvents(displaySlider);
    }

    addContrastSliderToPanel(display) {
        if (!display.contrastEnabled)
            return;
        const onContrastSliderChange = (quickSettingsSlider, newValue) => {
            this.setContrast(display, newValue);
        };
        const contrastDisplayName = `${display.name} (${_('Contrast')})`;
        const contrastIcon = 'preferences-color-symbolic';
        let contrastSlider = null;
        if (this.settings.get_int('button-location') === 0) {
            contrastSlider = new SingleMonitorSliderAndValueForStatusAreaMenu(
                this.settings,
                contrastDisplayName,
                display.currentContrast,
                onContrastSliderChange,
                display.minContrast,
                display.maxContrast,
                contrastIcon
            );
        } else if (this.settings.get_boolean('show-sliders-in-submenu')) {
            contrastSlider = new SingleMonitorSliderAndValueForQuickSettingsSubMenu({
                settings: this.settings,
                'display-name': contrastDisplayName,
                'current-value': display.currentContrast,
                'icon-name': contrastIcon,
                'min-value': display.minContrast,
                'max-value': display.maxContrast,
            });
            contrastSlider.connect('slider-change', onContrastSliderChange);
        } else {
            contrastSlider = new SingleMonitorSliderAndValueForQuickSettings({
                settings: this.settings,
                'display-name': contrastDisplayName,
                'current-value': display.currentContrast,
                'icon-name': contrastIcon,
                'min-value': display.minContrast,
                'max-value': display.maxContrast,
            });
            contrastSlider.connect('slider-change', onContrastSliderChange);
        }

        display.contrastSlider = contrastSlider;
        if (this.settings.get_boolean('show-sliders-in-submenu') && this.settings.get_boolean('show-all-slider'))
            mainMenuButton.getStoredSliders()[0].menu.addMenuItem(contrastSlider);
        else
            mainMenuButton.addMenuItem(contrastSlider);
        /*
            contrast sliders are intentionally not stored for scroll/keyboard
            events, so that the brightness controls never touch contrast
            (the contrast indicator has its own controls instead).
        */
    }

    /*
       reload menu widgets being called many time caused some lag
       after every display info was parsed, add this should run reloadMenuWidgets only once
     */
    reloadMenuWidgets() {
        if (_reloadMenuWidgetsTimer)
            clearTimeout(_reloadMenuWidgetsTimer);

        _reloadMenuWidgetsTimer = setTimeout(() => {
            _reloadMenuWidgetsTimer = null;
            this._reloadMenuWidgets();
        }, 1000);
    }

    _reloadMenuWidgets() {
        if (reloadingExtension) {
            /* do nothing if extension is being reloaded */
            brightnessLog(this.settings, `Skipping reloadMenuWidgets because extensions is reloading, timer ref: ${_reloadExtensionTimer}`);
            return;
        }

        if (mainMenuButton === null)
            return;


        brightnessLog(this.settings, 'Reloading widgets');

        mainMenuButton.removeAllMenu();
        mainMenuButton.clearStoredSliders();

        if (displays.length === 0) {
            mainMenuButton.indicatorVisibility(false);
            if (contrastMenuButton !== null)
                contrastMenuButton.indicatorVisibility(false);
        } else {
            mainMenuButton.indicatorVisibility(true);
            if (contrastMenuButton !== null) {
                const hasContrast = displays.some(display => display.contrastEnabled);
                contrastMenuButton.indicatorVisibility(hasContrast);
            }

            if (this.settings.get_boolean('show-all-slider'))
                this.addAllSlider();

            displays.forEach(display => {
                this.addDisplayToPanel(display);
                if (this.settings.get_boolean('show-contrast-sliders'))
                    this.addContrastSliderToPanel(display);
            });
            this.syncAllSlider();

            this.addSettingsItem();
            if (this.settings.get_int('button-location') === 0) {

            } else {
                /* in case of quick settings we need to add items after all the sliders were created */

                /*  easiest way to add sliders to panel area is :
                    QuickSettingsPanelMenuButton._addItems(mainMenuButton.quickSettingsItems, 2);
                    we need something more though.
                */
                const _grid = QuickSettingsPanelMenuButton.menu._grid;
                /*
                    but we want custom positioning, this is bit of a hack to access
                    _grid (St.Widget) directly and add items there,
                */
                let position = this.settings.get_double('position-system-menu');
                mainMenuButton.quickSettingsItems.forEach(item => {
                    /*
                        also for Label and Name we are accessing slider's parent's parent
                        Slider->Parent(St.Bin)->Parent(St.BoxLayout)
                    */
                    const _box = item.slider.get_parent().get_parent();
                    if (this.settings.get_boolean('show-display-name'))
                        _box.insert_child_at_index(item.NameContainer, 1);

                    /* increment the position so items keep the order they were created in */
                    _grid.insert_child_at_index(item, position++);
                    QuickSettingsPanelMenuButton.menu._completeAddItem(item, 2);
                    if (this.settings.get_boolean('show-value-label'))
                        _box.insert_child_at_index(item.ValueLabel, 3);
                });
            }
        }
    }

    /*
       reloading extension being called many times caused some lag
       and also reloading menu widgets when reload extension was already called
       caused unecessary extra ddcutil calls.
     */
    reloadExtension() {
        reloadingExtension = true;
        if (_reloadExtensionTimer)
            clearTimeout(_reloadExtensionTimer);

        _reloadExtensionTimer = setTimeout(() => {
            _reloadExtensionTimer = null;
            this._reloadExtension();
        }, 1000);
    }

    _reloadExtension() {
        brightnessLog(this.settings, 'Reload extension');
        this.disableBrightnessControl();
        this.enableBrightnessControl();
        reloadingExtension = false;
    }

    moveIndicator() {
        brightnessLog(this.settings, 'System indicator moved');
        if (mainMenuButton === null)
            return;
        QuickSettingsPanelMenuButton._indicators.set_child_at_index(mainMenuButton, this.settings.get_double('position-system-indicator'));
    }


    addTextItemToPanel(text) {
        if (mainMenuButton === null)
            return;
        const menuItem = new PopupMenu.PopupMenuItem(text, {
            reactive: false,
        });
        mainMenuButton.addMenuItem(menuItem);
    }
    busValidate(ddcLine) {
        return ddcLine.indexOf('/dev/i2c-') !== -1 && ddcLine.indexOf('Associated non-phantom display') === -1
    }

    getVCPList() {
        let vcpList = []
        if (this.settings.get_boolean('vcp-6b')) {
            vcpList.push("6B")
        }
        if (this.settings.get_boolean('vcp-10')) {
            vcpList.push("10")
        }
        return vcpList
    }

    displayInGoodState(ddcutilResponse) {
        const ddcutilResponseArray = getVCPInfoAsArray(ddcutilResponse)
        let displayInGoodState = true;
        if (!this.settings.get_boolean('disable-display-state-check')) {
            /*
                D6 = Power mode
                x01 = DPM: On,  DPMS: Off
            */
            displayInGoodState = ddcutilResponseArray.length >= 4 && ddcutilResponseArray[3] === 'x01';
        }
        return displayInGoodState
    }

    displayValidate(ddcutilResponse) {
        return (ddcutilResponse.indexOf('DDC communication failed') === -1 && ddcutilResponse.indexOf('No monitor detected') === -1)
    }

    displayResponseError(ddcutilResponse) {
        const ddcutilResponseArray = getVCPInfoAsArray(ddcutilResponse)
        return (ddcutilResponseArray[2] === 'ERR')
    }

    afterGetDdcutilBrightnessResponseSuccess(displayBus, displayName, vcp, ddcutilResponseArray) {
        let display = {};
        const maxBrightness = ddcutilResponseArray[4];
        /* we need current brightness in the scale of 0 to 1 for slider*/
        const currentBrightness = ddcutilResponseArray[3] / ddcutilResponseArray[4];
        /* make display object */
        display = {
            'bus': displayBus,
            'max': maxBrightness,
            'current': currentBrightness,
            'name': displayName,
            'vcp': vcp,
            /* contrast support state, filled in when fetchContrastValue succeeds */
            'contrastEnabled': false,
            'minContrast': 0,
            'maxContrast': 100,
            'currentContrast': 0.5,
            'contrastSlider': null,
        };
        brightnessLog(this.settings, `added display to list ${JSON.stringify(display)}`);
        displays.push(display);

        if (this.settings.get_boolean('vcp-12'))
            this.fetchContrastValue(display);

        /* cheap way of reloading all display slider in the panel */
        this.reloadMenuWidgets();
    }

    async ddcutilCommandLine(vcp, displayBus, callback) {
        const ddcutilPath = this.settings.get_string('ddcutil-binary-path');
        const sleepMultiplier = this.settings.get_double('ddcutil-sleep-multiplier') / 40;
        const command = [ddcutilPath, 'getvcp', '--brief', vcp, '--bus', displayBus, '--sleep-multiplier', sleepMultiplier.toString()]
        await spawnWithCallback(this.settings, command, callback);
    }

    async getDdcutilResponse(displayBus, displayName, vcpListIndex, ddcutilResponse) {
        //this will try and call getvcp on each vcp from vcpList until it doesn't return an error.
        const vcpList = this.getVCPList()
        if (this.displayValidate(ddcutilResponse)) {
            if (this.displayResponseError(ddcutilResponse)) {
                vcpListIndex += 1
                if (vcpListIndex < vcpList.length) {
                    /* read the current and max brightness using getvcp */
                    brightnessLog(this.settings, `calling ddcutil getvcp ${vcpList[vcpListIndex]} for bus ${displayBus}`);
                    await this.ddcutilCommandLine(vcpList[vcpListIndex], displayBus, async ddcutilReponseInner => {
                        brightnessLog(this.settings, `ddcutil getvcp ${vcpList[vcpListIndex]} for bus ${displayBus} is : ${ddcutilReponseInner.replace(/\n+$/, '')}`);
                        return await this.getDdcutilResponse(displayBus, displayName, vcpListIndex, ddcutilReponseInner)
                    });
                }
            } else {
                const ddcutilResponseArray = getVCPInfoAsArray(ddcutilResponse)
                if (ddcutilResponseArray.length >= 5) {
                    brightnessLog(this.settings, `ddcutil getvcp ${vcpList[vcpListIndex]} got success response for bus ${displayBus}`);
                    this.afterGetDdcutilBrightnessResponseSuccess(displayBus, displayName, vcpList[vcpListIndex], ddcutilResponseArray)
                }
            }
        }
    }

    async parseDisplaysInfoAndAddToPanel(ddcutilBriefInfo) {
        if (this.settings.get_boolean('show-internal-slider')) {
            let proxy = new BrightnessProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH);
            let current = proxy.Brightness / 100

            let display = {'bus': 'internal', 'max': 100, 'current': current, 'name': _('Internal')}
            if (Number.isInteger(current) && current >= 0)
                displays.push(display)
        }
        try {
            let displayBus;
            let displayName;

            brightnessLog(this.settings, `ddcutil brief info:\n${ddcutilBriefInfo}`);
            const lines = ddcutilBriefInfo.split('\n');
            for (const i in lines) {
                const ddcLine = lines[i];

                if (ddcLine.trim().length === 0) {
                    displayBus = null;
                    displayName = null;
                }

                if (this.busValidate(ddcLine)) {
                    displayBus = ddcLine.split('/dev/i2c-')[1].trim();
                    brightnessLog(this.settings, `ddcutil brief info found bus: ${displayBus}`);
                }

                if (ddcLine.indexOf('Monitor:') !== -1) {
                    displayName = ddcLine.split('Monitor:')[1].trim().split(':')[1].trim();
                    brightnessLog(this.settings, `ddcutil brief info found name: ${displayName}`);
                }

                if (!isNullOrWhitespace(displayBus) && !isNullOrWhitespace(displayName)) {
                    /* guard against ddcutil occasionally reporting the same
                       monitor twice within one detect run (e.g. right after
                       login while the panel is still being re-enumerated) */
                    if (displays.some(display => display.bus === displayBus)) {
                        brightnessLog(this.settings, `Skipping duplicate display on bus ${displayBus}: ${displayName}`);
                        displayBus = null;
                        displayName = null;
                        continue;
                    }
                    await this.addDisplayToPanelIfItIsOn(displayBus, displayName);

                    displayBus = null;
                    displayName = null;
                }
            }
        } catch (err) {
            brightnessLog(this.settings, err);
        }
    }

    async addDisplayToPanelIfItIsOn(displayBus, displayName) {
        /* check if display is on or not */
        await this.ddcutilCommandLine('D6', displayBus, async ddcutilResponsePowerMode => {
            brightnessLog(this.settings, `ddcutil display power state for bus: ${displayBus} is: ${ddcutilResponsePowerMode.replace(/\n+$/, '')}`);
            /* only add display to list if ddc communication is supported with the bus*/
            if (this.displayValidate(ddcutilResponsePowerMode) &&
                this.displayInGoodState(ddcutilResponsePowerMode)) {
                // start with an ERR, so that the getDdcutilResponse will directly call
                // move to call with index 0
                await this.getDdcutilResponse(displayBus, displayName, -1, "VCP 0 ERR")
            }
        });
    }

    async getDisplaysInfoAsync() {
        const ddcutilPath = this.settings.get_string('ddcutil-binary-path');
        await spawnWithCallback(this.settings, [ddcutilPath, 'detect', '--brief'], async ddcutilBriefInfo => {
            await this.parseDisplaysInfoAndAddToPanel(ddcutilBriefInfo);
        });
    }

    async getCachedDisplayInfoAsync() {
        const file = Gio.File.new_for_path(ddcutilDetectCacheFile);
        const cancellable = new Gio.Cancellable();
        file.load_contents_async(cancellable, async (source, result) => {
            try {
                const [ok, contents, etagOut] = source.load_contents_finish(result);
                const decoder = new TextDecoder('utf-8');
                await this.parseDisplaysInfoAndAddToPanel(decoder.decode(contents));
            } catch (e) {
                brightnessLog(this.settings, `${ddcutilDetectCacheFile} cache file reading error`);
            }
        });
        spawnWithCallback(this.settings, ['cat', ddcutilDetectCacheFile], stdout => { });
    }

    settingsToJSObject() {
        const out = {
            'allow-zero-brightness': this.settings.get_boolean('allow-zero-brightness'),
            'disable-display-state-check': this.settings.get_boolean('disable-display-state-check'),
            'hide-system-indicator': this.settings.get_boolean('hide-system-indicator'),
            'only-all-slider': this.settings.get_boolean('only-all-slider'),
            'show-all-slider': this.settings.get_boolean('show-all-slider'),
            'show-display-name': this.settings.get_boolean('show-display-name'),
            'show-value-label': this.settings.get_boolean('show-value-label'),
            'show-sliders-in-submenu': this.settings.get_boolean('show-sliders-in-submenu'),
            'show-contrast-sliders': this.settings.get_boolean('show-contrast-sliders'),
            'show-contrast-indicator': this.settings.get_boolean('show-contrast-indicator'),
            'vcp-6b': this.settings.get_boolean('vcp-6b'),
            'vcp-10': this.settings.get_boolean('vcp-10'),
            'vcp-12': this.settings.get_boolean('vcp-12'),
            'contrast-min': this.settings.get_double('contrast-min'),
            'verbose-debugging': this.settings.get_boolean('verbose-debugging'),
            'ddcutil-sleep-multiplier': this.settings.get_double('ddcutil-sleep-multiplier'),
            'position-system-indicator': this.settings.get_double('position-system-indicator'),
            'position-system-menu': this.settings.get_double('position-system-menu'),
            'step-change-keyboard': this.settings.get_double('step-change-keyboard'),
            'button-location': this.settings.get_int('button-location'),
            'ddcutil-additional-args': this.settings.get_string('ddcutil-additional-args'),
            'ddcutil-binary-path': this.settings.get_string('ddcutil-binary-path'),
            'decrease-brightness-shortcut': this.settings.get_strv('decrease-brightness-shortcut'),
            'increase-brightness-shortcut': this.settings.get_strv('increase-brightness-shortcut'),
            'decrease-contrast-shortcut': this.settings.get_strv('decrease-contrast-shortcut'),
            'increase-contrast-shortcut': this.settings.get_strv('increase-contrast-shortcut'),
        };
        return out;
    }

    onSettingsChange() {
        brightnessLog(this.settings, 'this.settings change detected, reloading widgets');
        this.removeKeyboardShortcuts();
        this.addKeyboardShortcuts();
        this.reloadMenuWidgets();
        if (this.settings.get_boolean('verbose-debugging'))
            brightnessLog(this.settings, JSON.stringify(this.settingsToJSObject()));
    }

    onMonitorChange() {
        /*
            when monitor change happens,
            sometimes the turned off monitor is still accepting DDC connection
            this is not a great fix, because some monitor
            will still take longer than 5 seconds to be off
        */
        brightnessLog(this.settings, 'Monitor change detected, reloading extension in 5 seconds.');
        if (monitorChangeTimeout !== null)
            clearTimeout(monitorChangeTimeout);

        monitorChangeTimeout = setTimeout(() => {
            monitorChangeTimeout = null;
            this.reloadExtension();
        }, 5000);
    }

    connectSettingsSignals() {
        oldSettings = this.settings;
        settingsSignals = {
            change: this.settings.connect('changed', () => {
                this.onSettingsChange();
            }),
            reload: this.settings.connect('changed::reload', () => {
                this.reloadExtension();
            }),
            vcp6b: this.settings.connect('changed::vcp-6b', () => {
                this.reloadExtension();
            }),
            vcp10: this.settings.connect('changed::vcp-10', () => {
                this.reloadExtension();
            }),
            vcp12: this.settings.connect('changed::vcp-12', () => {
                this.reloadExtension();
            }),
            show_contrast_sliders: this.settings.connect('changed::show-contrast-sliders', () => {
                this.reloadExtension();
            }),
            show_contrast_indicator: this.settings.connect('changed::show-contrast-indicator', () => {
                this.reloadExtension();
            }),
            contrast_min: this.settings.connect('changed::contrast-min', () => {
                this.reloadExtension();
            }),
            indicator: this.settings.connect('changed::button-location', () => {
                this.reloadExtension();
            }),
            hide_system_indicator: this.settings.connect('changed::hide-system-indicator', () => {
                this.reloadExtension();
            }),
            position_system_indicator: this.settings.connect('changed::position-system-indicator', () => {
                this.moveIndicator();
            }),
            position_system_menu: this.settings.connect('changed::position-system-menu', () => {
                this.reloadExtension();
            }),
            disable_display_state_check: this.settings.connect('changed::disable-display-state-check', () => {
                this.reloadExtension();
            }),
            verbose_debugging: this.settings.connect('changed::verbose-debugging', () => {
                this.reloadExtension();
            }),
        };
    }

    connectMonitorChangeSignals() {
        monitorSignals = {
            change: Main.layoutManager.connect('monitors-changed', this.onMonitorChange.bind(this)),
        };
    }

    disconnectSettingsSignals() {
        Object.values(settingsSignals).forEach(signal => {
            oldSettings.disconnect(signal);
        });
        settingsSignals = {};
        oldSettings = null;
    }

    disconnectMonitorSignals() {
        Main.layoutManager.disconnect(monitorSignals.change);
    }

    async addAllDisplaysToPanel() {
        try {
            if (GLib.file_test(ddcutilDetectCacheFile, GLib.FileTest.IS_REGULAR))
                await this.getCachedDisplayInfoAsync();
            else
                await this.getDisplaysInfoAsync();
        } catch (err) {
            brightnessLog(this.settings, err);
        }
    }

    increase() {
        brightnessLog(this.settings, 'Increase brightness');
        mainMenuButton.emit('value-up');
    }

    decrease() {
        brightnessLog(this.settings, 'Decrease brightness');
        mainMenuButton.emit('value-down');
    }

    increaseContrast() {
        brightnessLog(this.settings, 'Increase contrast');
        this.adjustAllContrast(this.settings.get_double('step-change-keyboard') / 100);
    }

    decreaseContrast() {
        brightnessLog(this.settings, 'Decrease contrast');
        this.adjustAllContrast(-(this.settings.get_double('step-change-keyboard') / 100));
    }

    addKeyboardShortcuts() {
        brightnessLog(this.settings, 'Add keyboard shortcuts');
        Main.wm.addKeybinding(
            'increase-brightness-shortcut',
            this.settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            this.increase.bind(this)
        );
        Main.wm.addKeybinding(
            'decrease-brightness-shortcut',
            this.settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            this.decrease.bind(this)
        );
        Main.wm.addKeybinding(
            'increase-contrast-shortcut',
            this.settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            this.increaseContrast.bind(this)
        );
        Main.wm.addKeybinding(
            'decrease-contrast-shortcut',
            this.settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            this.decreaseContrast.bind(this)
        );
    }

    removeKeyboardShortcuts() {
        brightnessLog(this.settings, 'Remove keyboard shortcuts');
        Main.wm.removeKeybinding('increase-brightness-shortcut');
        Main.wm.removeKeybinding('decrease-brightness-shortcut');
        Main.wm.removeKeybinding('increase-contrast-shortcut');
        Main.wm.removeKeybinding('decrease-contrast-shortcut');
    }
}
