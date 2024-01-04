# Lean WebUSB device

Based on the [Web Serial Polyfill](https://github.com/google/web-serial-polyfill), this implementation removes the control interface and unnecessary options while still allowing the underlying USB device to be used for streaming data for reading and writing.

# Chrome info and settings

chrome://device-log/ 
chrome://usb-internals/
chrome://settings/content/usbDevices/
chrome://prefs-internals/    then search the output for usb_chooser_data

# Webserial

https://wicg.github.io/serial/