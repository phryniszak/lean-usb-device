/*
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in
 * compliance with the License. You may obtain a copy of
 * the License at
 *
 *    https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in
 * writing, software distributed under the License is
 * distributed on an "AS IS" BASIS, WITHOUT WARRANTIES
 * OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing
 * permissions and limitations under the License.
 */

const kDefaultBufferSize = 255;
const kDefaultUsbTransferInterfaceClass = 0xFF;

/**
 * Utility function to get the interface implementing a desired class.
 * @param {USBDevice} device The USB device.
 * @param {number} classCode The desired interface class.
 * @return {USBInterface} The first interface found that implements the desired
 * class.
 * @throws TypeError if no interface is found.
 */
function findInterface(device: USBDevice, classCode: number): USBInterface {
  const configuration = device.configurations[0];
  for (const iface of configuration.interfaces) {
    const alternate = iface.alternates[0];
    if (alternate.interfaceClass === classCode) {
      return iface;
    }
  }
  throw new TypeError(`Unable to find interface with class ${classCode}.`);
}

/**
 * Utility function to get an endpoint with a particular direction.
 * @param {USBInterface} iface The interface to search.
 * @param {USBDirection} direction The desired transfer direction.
 * @return {USBEndpoint} The first endpoint with the desired transfer direction.
 * @throws TypeError if no endpoint is found.
 */
function findEndpoint(iface: USBInterface, direction: USBDirection):
    USBEndpoint {
  const alternate = iface.alternates[0];
  for (const endpoint of alternate.endpoints) {
    if (endpoint.direction == direction) {
      return endpoint;
    }
  }
  throw new TypeError(`Interface ${iface.interfaceNumber} does not have an ` +
                      `${direction} endpoint.`);
}

/**
 * Implementation of the underlying source API[1] which reads data from a USB
 * endpoint. This can be used to construct a ReadableStream.
 *
 * [1]: https://streams.spec.whatwg.org/#underlying-source-api
 */
class UsbEndpointUnderlyingSource implements UnderlyingByteSource {
  private device_: USBDevice;
  private endpoint_: USBEndpoint;
  private onError_: () => void;

  type: 'bytes';

  /**
   * Constructs a new UnderlyingSource that will pull data from the specified
   * endpoint on the given USB device.
   *
   * @param {USBDevice} device
   * @param {USBEndpoint} endpoint
   * @param {function} onError function to be called on error
   */
  constructor(device: USBDevice, endpoint: USBEndpoint, onError: () => void) {
    this.type = 'bytes';
    this.device_ = device;
    this.endpoint_ = endpoint;
    this.onError_ = onError;
  }

  /**
   * Reads a chunk of data from the device.
   *
   * @param {ReadableByteStreamController} controller
   */
  pull(controller: ReadableByteStreamController): void {
    (async (): Promise<void> => {
      let chunkSize;
      if (controller.desiredSize) {
        const d = controller.desiredSize / this.endpoint_.packetSize;
        chunkSize = Math.ceil(d) * this.endpoint_.packetSize;
      } else {
        chunkSize = this.endpoint_.packetSize;
      }

      try {
        const result = await this.device_.transferIn(
            this.endpoint_.endpointNumber, chunkSize);
        if (result.status != 'ok') {
          controller.error(`USB error: ${result.status}`);
          this.onError_();
        }
        if (result.data?.buffer) {
          const chunk = new Uint8Array(
              result.data.buffer, result.data.byteOffset,
              result.data.byteLength);
          controller.enqueue(chunk);
        }
      } catch (error) {
        controller.error(error.toString());
        this.onError_();
      }
    })();
  }
}

/**
 * Implementation of the underlying sink API[2] which writes data to a USB
 * endpoint. This can be used to construct a WritableStream.
 *
 * [2]: https://streams.spec.whatwg.org/#underlying-sink-api
 */
class UsbEndpointUnderlyingSink implements UnderlyingSink<Uint8Array> {
  private device_: USBDevice;
  private endpoint_: USBEndpoint;
  private onError_: () => void;

  /**
   * Constructs a new UnderlyingSink that will write data to the specified
   * endpoint on the given USB device.
   *
   * @param {USBDevice} device
   * @param {USBEndpoint} endpoint
   * @param {function} onError function to be called on error
   */
  constructor(device: USBDevice, endpoint: USBEndpoint, onError: () => void) {
    this.device_ = device;
    this.endpoint_ = endpoint;
    this.onError_ = onError;
  }

  /**
   * Writes a chunk to the device.
   *
   * @param {Uint8Array} chunk
   * @param {WritableStreamDefaultController} controller
   */
  async write(
      chunk: Uint8Array,
      controller: WritableStreamDefaultController): Promise<void> {
    try {
      const result =
          await this.device_.transferOut(this.endpoint_.endpointNumber, chunk);
      if (result.status != 'ok') {
        controller.error(result.status);
        this.onError_();
      }
    } catch (error) {
      controller.error(error.toString());
      this.onError_();
    }
  }
}

/** a class used to control serial devices over WebUSB */
export class LeanDevice {
  private device_: USBDevice;
  private transferInterface_: USBInterface;
  private inEndpoint_: USBEndpoint;
  private outEndpoint_: USBEndpoint;

  private readable_: ReadableStream<Uint8Array> | null;
  private writable_: WritableStream<Uint8Array> | null;

  /**
   * constructor taking a WebUSB device that creates a SerialPort instance.
   * @param {USBDevice} device A device acquired from the WebUSB API
   * configure the polyfill.
   */
  public constructor(
      device: USBDevice) {
    this.device_ = device;
    this.transferInterface_ = findInterface(
        this.device_, kDefaultUsbTransferInterfaceClass);
    this.inEndpoint_ = findEndpoint(this.transferInterface_, 'in');
    this.outEndpoint_ = findEndpoint(this.transferInterface_, 'out');
  }

  /**
   * Getter for the readable attribute. Constructs a new ReadableStream as
   * necessary.
   * @return {ReadableStream} the current readable stream
   */
  public get readable(): ReadableStream<Uint8Array> | null {
    if (!this.readable_ && this.device_.opened) {
      this.readable_ = new ReadableStream<Uint8Array>(
          new UsbEndpointUnderlyingSource(
              this.device_, this.inEndpoint_, () => {
                this.readable_ = null;
              }),
          {
            highWaterMark: kDefaultBufferSize,
          });
    }
    return this.readable_;
  }

  /**
   * Getter for the writable attribute. Constructs a new WritableStream as
   * necessary.
   * @return {WritableStream} the current writable stream
   */
  public get writable(): WritableStream<Uint8Array> | null {
    if (!this.writable_ && this.device_.opened) {
      this.writable_ = new WritableStream(
          new UsbEndpointUnderlyingSink(
              this.device_, this.outEndpoint_, () => {
                this.writable_ = null;
              }),
          new ByteLengthQueuingStrategy({
            highWaterMark: kDefaultBufferSize,
          }));
    }
    return this.writable_;
  }

  /**
   * a function that opens the device and claims all interfaces needed to
   * control and communicate to and from the serial device
   * @return {Promise<void>} A promise that will resolve when device is ready
   * for communication
   */
  public async open(): Promise<void> {
    try {
      await this.device_.open();
      if (this.device_.configuration === null) {
        await this.device_.selectConfiguration(1);
      }
      await this.device_.claimInterface(
          this.transferInterface_.interfaceNumber);
    } catch (error) {
      if (this.device_.opened) {
        await this.device_.close();
      }
      throw new Error('Error setting up device: ' + error.toString());
    }
  }

  /**
   * Closes the port.
   *
   * @return {Promise<void>} A promise that will resolve when the port is
   * closed.
   */
  public async close(): Promise<void> {
    const promises = [];
    if (this.readable_) {
      promises.push(this.readable_.cancel());
    }
    if (this.writable_) {
      promises.push(this.writable_.abort());
    }
    await Promise.all(promises);
    this.readable_ = null;
    this.writable_ = null;
    if (this.device_.opened) {
      await this.device_.close();
    }
  }

  /**
   * Forgets the port.
   *
   * @return {Promise<void>} A promise that will resolve when the port is
   * forgotten.
   */
  public async forget(): Promise<void> {
    return this.device_.forget();
  }

  /**
   * A function that returns properties of the device.
   * @return {SerialPortInfo} Device properties.
   */
  public getInfo() {
    return {
      usbVendorId: this.device_.vendorId,
      usbProductId: this.device_.productId,
    };
  }
}
