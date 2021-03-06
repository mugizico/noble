/*jshint loopfunc: true */

var debug = require('debug')('l2cap-ble');

var events = require('events');
var spawn = require('child_process').spawn;
var util = require('util');

var ATT_OP_ERROR                = 0x01;
var ATT_OP_FIND_INFO_REQ        = 0x04;
var ATT_OP_FIND_INFO_RESP       = 0x05;
var ATT_OP_READ_BY_TYPE_REQ     = 0x08;
var ATT_OP_READ_BY_TYPE_RESP    = 0x09;
var ATT_OP_READ_REQ             = 0x0a;
var ATT_OP_READ_RESP            = 0x0b;
var ATT_OP_READ_BY_GROUP_REQ    = 0x10;
var ATT_OP_READ_BY_GROUP_RESP   = 0x11;
var ATT_OP_WRITE_REQ            = 0x12;
var ATT_OP_WRITE_RESP           = 0x13;
var ATT_OP_HANDLE_NOTIFY        = 0x1b;
var ATT_OP_WRITE_CMD            = 0x52;

var GATT_PRIM_SVC_UUID          = 0x2800;
var GATT_INCLUDE_UUID           = 0x2802;
var GATT_CHARAC_UUID            = 0x2803;

var GATT_CLIENT_CHARAC_CFG_UUID = 0x2902;
var GATT_SERVER_CHARAC_CFG_UUID = 0x2903;

var L2capBle = function(address, addressType) {
  this._address = address;
  this._addressType = addressType;

  this._services = {};
  this._characteristics = {};
  this._descriptors = {};

  this._currentCommand = null;
  this._commandQueue = [];
};

util.inherits(L2capBle, events.EventEmitter);

L2capBle.prototype.kill = function() {
  this._l2capBle.kill();
};

L2capBle.prototype.onClose = function(code) {
  debug('close = ' + code);
};

L2capBle.prototype.onStdoutData = function(data) {
  this._buffer += data.toString();

  debug('buffer = ' + JSON.stringify(this._buffer));

  var newLineIndex;
  while ((newLineIndex = this._buffer.indexOf('\n')) !== -1) {
    var line = this._buffer.substring(0, newLineIndex);
    var found;
    
    this._buffer = this._buffer.substring(newLineIndex + 1);

    debug('line = ' + line);

    if ((found = line.match(/^connect (.*)$/))) {
      // TODO: use found

      this.emit('connect', this._address);
    } else if ((found = line.match(/^disconnect$/))) {
      this.emit('disconnect', this._address);
    } else if ((found = line.match(/^rssi = (.*)$/))) {
      var rssi = parseInt(found[1], 10);

      this.emit('rssi', this._address, rssi);
    } else if ((found = line.match(/^data (.*)$/))) {
      var lineData = new Buffer(found[1], 'hex');

      if (this._currentCommand && lineData.toString('hex') === this._currentCommand.buffer.toString('hex')) {
        debug('echo ... echo ... echo ...');
      } else if (lineData[0] === ATT_OP_HANDLE_NOTIFY) {
        var valueHandle = lineData.readUInt16LE(1);
        var valueData = lineData.slice(3);

        for (var serviceUuid in this._services) {
          for (var characteristicUuid in this._characteristics[serviceUuid]) {
            if (this._characteristics[serviceUuid][characteristicUuid].valueHandle === valueHandle) {
              this.emit('notification', this._address, serviceUuid, characteristicUuid, valueData);
            }
          }
        }
      } else if (!this._currentCommand) {
        debug('uh oh, no current command');
      } else {
        this._currentCommand.callback(lineData);

        this._currentCommand = null;
        
        while(this._commandQueue.length) {
          this._currentCommand = this._commandQueue.pop();
          
          debug('write: ' + this._currentCommand.buffer.toString('hex'));
          this._l2capBle.stdin.write(this._currentCommand.buffer.toString('hex') + '\n');

          if (this._currentCommand.callback) {
            break;
          } else if (this._currentCommand.writeCallback) {
            this._currentCommand.writeCallback();

            this._currentCommand = null;
          }
        }
      }
    }
  }
};

L2capBle.prototype.onStderrData = function(data) {
  console.error('stderr: ' + data);
};

L2capBle.prototype.connect = function() {
  var l2capBle = __dirname + '/../../build/Release/l2cap-ble';
  
  debug('l2capBle = ' + l2capBle);

  this._l2capBle = spawn('stdbuf', ['-o', '0', '-e', '0', '-i', '0', l2capBle, this._address, this._addressType]);
  this._l2capBle.on('close', this.onClose.bind(this));
  this._l2capBle.stdout.on('data', this.onStdoutData.bind(this));
  this._l2capBle.stderr.on('data', this.onStderrData.bind(this));

  this._buffer = "";
};

L2capBle.prototype.disconnect = function() {
  this._l2capBle.kill('SIGHUP');
};

L2capBle.prototype.updateRssi = function() {
  this._l2capBle.kill('SIGUSR1');
};

L2capBle.prototype._queueCommand = function(buffer, callback, writeCallback) {
  this._commandQueue.push({
    buffer: buffer,
    callback: callback,
    writeCallback: writeCallback
  });

  if (this._currentCommand === null) {
    while (this._commandQueue.length) {
      this._currentCommand = this._commandQueue.shift();

      debug('write: ' + this._currentCommand.buffer.toString('hex'));
      this._l2capBle.stdin.write(this._currentCommand.buffer.toString('hex') + '\n');

      if (this._currentCommand.callback) {
        break;
      } else if (this._currentCommand.writeCallback) {
        this._currentCommand.writeCallback();

        this._currentCommand = null;
      }
    }
  }
};

L2capBle.prototype.readByGroupRequest = function(startHandle, endHandle, groupUuid) {
  var buf = new Buffer(7);

  buf.writeUInt8(ATT_OP_READ_BY_GROUP_REQ, 0);
  buf.writeUInt16LE(startHandle, 1);
  buf.writeUInt16LE(endHandle, 3);
  buf.writeUInt16LE(groupUuid, 5);

  return buf;
};

L2capBle.prototype.readByTypeRequest = function(startHandle, endHandle, groupUuid) {
  var buf = new Buffer(7);

  buf.writeUInt8(ATT_OP_READ_BY_TYPE_REQ, 0);
  buf.writeUInt16LE(startHandle, 1);
  buf.writeUInt16LE(endHandle, 3);
  buf.writeUInt16LE(groupUuid, 5);

  return buf;
};

L2capBle.prototype.readRequest = function(handle) {
  var buf = new Buffer(3);

  buf.writeUInt8(ATT_OP_READ_REQ, 0);
  buf.writeUInt16LE(handle, 1);

  return buf;
};

L2capBle.prototype.findInfoRequest = function(startHandle, endHandle) {
  var buf = new Buffer(5);

  buf.writeUInt8(ATT_OP_FIND_INFO_REQ, 0);
  buf.writeUInt16LE(startHandle, 1);
  buf.writeUInt16LE(endHandle, 3);

  return buf;
};

L2capBle.prototype.writeRequest = function(handle, data, withoutResponse) {
  var buf = new Buffer(3 + data.length);

  buf.writeUInt8(withoutResponse ? ATT_OP_WRITE_CMD : ATT_OP_WRITE_REQ , 0);
  buf.writeUInt16LE(handle, 1);

  for (var i = 0; i < data.length; i++) {
    buf.writeUInt8(data.readUInt8(i), i + 3);
  }

  return buf;
};

L2capBle.prototype.discoverServices = function(uuids) {
  var services = [];

  var callback = function(data) {
    var opcode = data[0];
    var i = 0;

    if (opcode === ATT_OP_READ_BY_GROUP_RESP) {
      var type = data[1];
      var num = (data.length - 2) / type;

      for (i = 0; i < num; i++) {
        services.push({
          startHandle: data.readUInt16LE(2 + i * type + 0),
          endHandle: data.readUInt16LE(2 + i * type + 2),
          uuid: (type == 6) ? data.readUInt16LE(2 + i * type + 4).toString(16) : data.slice(2 + i * type + 4).slice(0, 16).toString('hex').match(/.{1,2}/g).reverse().join('')
        });
      }
    }

    if (opcode !== ATT_OP_READ_BY_GROUP_RESP || services[services.length - 1].endHandle === 0xffff) {
      var serviceUuids = [];
      for (i = 0; i < services.length; i++) {
        if (uuids.length === 0 || uuids.indexOf(services[i].uuid) !== -1) {
          serviceUuids.push(services[i].uuid);
        }

        this._services[services[i].uuid] = services[i];
      }
      this.emit('servicesDiscover', this._address, serviceUuids);
    } else {
      this._queueCommand(this.readByGroupRequest(services[services.length - 1].endHandle, 0xffff, GATT_PRIM_SVC_UUID), callback);
    }
  }.bind(this);
  
  this._queueCommand(this.readByGroupRequest(0x0001, 0xffff, GATT_PRIM_SVC_UUID), callback);
};

L2capBle.prototype.discoverIncludedServices = function(serviceUuid, uuids) {
  var service = this._services[serviceUuid];
  var includedServices = [];

  var callback = function(data) {
    var opcode = data[0];
    var i = 0;

    if (opcode === ATT_OP_READ_BY_TYPE_RESP) {
      var type = data[1];
      var num = (data.length - 2) / type;

      for (i = 0; i < num; i++) {
        includedServices.push({
          endHandle: data.readUInt16LE(2 + i * type + 0),
          startHandle: data.readUInt16LE(2 + i * type + 2),
          uuid: (type == 8) ? data.readUInt16LE(2 + i * type + 6).toString(16) : data.slice(2 + i * type + 6).slice(0, 16).toString('hex').match(/.{1,2}/g).reverse().join('')
        });
      }
    }

    if (opcode !== ATT_OP_READ_BY_TYPE_RESP || includedServices[includedServices.length - 1].endHandle === service.endHandle) {
      var includedServiceUuids = [];

      for (i = 0; i < includedServices.length; i++) {
        if (uuids.length === 0 || uuids.indexOf(includedServices[i].uuid) !== -1) {
          includedServiceUuids.push(includedServices[i].uuid);
        }
      }

      this.emit('includedServicesDiscover', this._address, service.uuid, includedServiceUuids);
    } else {
      this._queueCommand(this.readByTypeRequest(includedServices[includedServices.length - 1].endHandle + 1, service.endHandle, GATT_INCLUDE_UUID), callback);
    }
  }.bind(this);
  
  this._queueCommand(this.readByTypeRequest(service.startHandle, service.endHandle, GATT_INCLUDE_UUID), callback);
};

L2capBle.prototype.discoverCharacteristics = function(serviceUuid, characteristicUuids) {
  var service = this._services[serviceUuid];
  var characteristics = [];

  this._characteristics[serviceUuid] = {};
  this._descriptors[serviceUuid] = {};

  var callback = function(data) {
    var opcode = data[0];
    var i = 0;

    if (opcode === ATT_OP_READ_BY_TYPE_RESP) {
      var type = data[1];
      var num = (data.length - 2) / type;

      for (i = 0; i < num; i++) {
        characteristics.push({
          startHandle: data.readUInt16LE(2 + i * type + 0),
          properties: data.readUInt8(2 + i * type + 2),
          valueHandle: data.readUInt16LE(2 + i * type + 3),
          uuid: (type == 7) ? data.readUInt16LE(2 + i * type + 5).toString(16) : data.slice(2 + i * type + 5).slice(0, 16).toString('hex').match(/.{1,2}/g).reverse().join('')
        });
      }
    }

    if (opcode !== ATT_OP_READ_BY_TYPE_RESP || characteristics[characteristics.length - 1].valueHandle === service.endHandle) {

      var characteristicsDiscovered = [];
      for (i = 0; i < characteristics.length; i++) {
        var properties = characteristics[i].properties;

        var characteristic = {
          properties: [],
          uuid: characteristics[i].uuid
        };

        if (i !== 0) {
          characteristics[i - 1].endHandle = characteristics[i].startHandle - 1;
        }

        if (i === (characteristics.length - 1)) {
          characteristics[i].endHandle = service.endHandle;
        }

        this._characteristics[serviceUuid][characteristics[i].uuid] = characteristics[i];

        if (properties & 0x01) {
          characteristic.properties.push('broadcast');
        }

        if (properties & 0x02) {
          characteristic.properties.push('read');
        }

        if (properties & 0x04) {
          characteristic.properties.push('writeWithoutResponse');
        }

        if (properties & 0x08) {
          characteristic.properties.push('write');
        }

        if (properties & 0x10) {
          characteristic.properties.push('notify');
        }

        if (properties & 0x20) {
          characteristic.properties.push('indicate');
        }

        if (properties & 0x40) {
          characteristic.properties.push('authenticatedSignedWrites');
        }

        if (properties & 0x80) {
          characteristic.properties.push('extendedProperties');
        }

        if (characteristicUuids.length === 0 || characteristicUuids.indexOf(characteristic.uuid) !== -1) {
          characteristicsDiscovered.push(characteristic);
        }
      }

      this.emit('characteristicsDiscover', this._address, serviceUuid, characteristicsDiscovered);
    } else {
      this._queueCommand(this.readByTypeRequest(characteristics[characteristics.length - 1].valueHandle + 1, service.endHandle, GATT_CHARAC_UUID), callback);
    }
  }.bind(this);
  
  this._queueCommand(this.readByTypeRequest(service.startHandle, service.endHandle, GATT_CHARAC_UUID), callback);
};

L2capBle.prototype.read = function(serviceUuid, characteristicUuid) {
  var characteristic = this._characteristics[serviceUuid][characteristicUuid];

  this._queueCommand(this.readRequest(characteristic.valueHandle), function(data) {
    var opcode = data[0];

    if (opcode === ATT_OP_READ_RESP) {
      this.emit('read', this._address, serviceUuid, characteristicUuid, data.slice(1));
    }
  }.bind(this));
};

L2capBle.prototype.write = function(serviceUuid, characteristicUuid, data, withoutResponse) {
  var characteristic = this._characteristics[serviceUuid][characteristicUuid];

  if (withoutResponse) {
    this._queueCommand(this.writeRequest(characteristic.valueHandle, data, true), null, function() {
      this.emit('write', this._address, serviceUuid, characteristicUuid);
    }.bind(this));
  } else {
    this._queueCommand(this.writeRequest(characteristic.valueHandle, data, false), function(data) {
      var opcode = data[0];

      if (opcode === ATT_OP_WRITE_RESP) {
        this.emit('write', this._address, serviceUuid, characteristicUuid);
      }
    }.bind(this));
  }
};

L2capBle.prototype.broadcast = function(serviceUuid, characteristicUuid, broadcast) {
  var characteristic = this._characteristics[serviceUuid][characteristicUuid];

  this._queueCommand(this.readByTypeRequest(characteristic.startHandle, characteristic.endHandle, GATT_SERVER_CHARAC_CFG_UUID), function(data) {
    var opcode = data[0];
    if (opcode === ATT_OP_READ_BY_TYPE_RESP) {
      var type = data[1];
      var handle = data.readUInt16LE(2);
      var value = data.readUInt16LE(4);

      if (notify) {
        value |= 0x0001;
      } else {
        value &= 0xfffe;
      }

      var valueBuffer = new Buffer(2);
      valueBuffer.writeUInt16LE(value, 0);

      this._queueCommand(this.writeRequest(handle, valueBuffer, false), function(data) {
        var opcode = data[0];

        if (opcode === ATT_OP_WRITE_RESP) {
          this.emit('broadcast', this._address, serviceUuid, characteristicUuid, broadcast);
        }
      }.bind(this));
    }
  }.bind(this));
};

L2capBle.prototype.notify = function(serviceUuid, characteristicUuid, notify) {
  var characteristic = this._characteristics[serviceUuid][characteristicUuid];

  this._queueCommand(this.readByTypeRequest(characteristic.startHandle, characteristic.endHandle, GATT_CLIENT_CHARAC_CFG_UUID), function(data) {
    var opcode = data[0];
    if (opcode === ATT_OP_READ_BY_TYPE_RESP) {
      var type = data[1];
      var handle = data.readUInt16LE(2);
      var value = data.readUInt16LE(4);

      if (notify) {
        value |= 0x0001;
      } else {
        value &= 0xfffe;
      }

      var valueBuffer = new Buffer(2);
      valueBuffer.writeUInt16LE(value, 0);

      this._queueCommand(this.writeRequest(handle, valueBuffer, false), function(data) {
        var opcode = data[0];

        if (opcode === ATT_OP_WRITE_RESP) {
          this.emit('notify', this._address, serviceUuid, characteristicUuid, notify);
        }
      }.bind(this));
    }
  }.bind(this));
};

L2capBle.prototype.discoverDescriptors = function(serviceUuid, characteristicUuid) {
  var characteristic = this._characteristics[serviceUuid][characteristicUuid];
  var descriptors = [];

  this._descriptors[serviceUuid][characteristicUuid] = {};

  var callback = function(data) {
    var opcode = data[0];
    var i = 0;

    if (opcode === ATT_OP_FIND_INFO_RESP) {
      var num = data[1];

      for (i = 0; i < num; i++) {
        descriptors.push({
          handle: data.readUInt16LE(2 + i * 4 + 0),
          uuid: data.readUInt16LE(2 + i * 4 + 2).toString(16)
        });
      }
    }

    if (opcode !== ATT_OP_FIND_INFO_RESP || descriptors[descriptors.length - 1].handle === characteristic.endHandle) {
      var descriptorUuids = [];
      for (i = 0; i < descriptors.length; i++) {
        descriptorUuids.push(descriptors[i].uuid);

        this._descriptors[serviceUuid][characteristicUuid][descriptors[i].uuid] = descriptors[i];
      }

      this.emit('descriptorsDiscover', this._address, serviceUuid, characteristicUuid, descriptorUuids);
    } else {
      this._queueCommand(this.findInfoRequest(descriptors[descriptors.length - 1].handle + 1, characteristic.endHandle), callback);
    }
  }.bind(this);
  
  this._queueCommand(this.findInfoRequest(characteristic.valueHandle + 1, characteristic.endHandle), callback);
};

L2capBle.prototype.readValue = function(serviceUuid, characteristicUuid, descriptorUuid) {
  var descriptor = this._descriptors[serviceUuid][characteristicUuid][descriptorUuid];

  this._queueCommand(this.readRequest(descriptor.handle), function(data) {
    var opcode = data[0];

    if (opcode === ATT_OP_READ_RESP) {
      this.emit('valueRead', this._address, serviceUuid, characteristicUuid, descriptorUuid, data.slice(1));
    }
  }.bind(this));
};

L2capBle.prototype.writeValue = function(serviceUuid, characteristicUuid, descriptorUuid, data) {
  var descriptor = this._descriptors[serviceUuid][characteristicUuid][descriptorUuid];

  this._queueCommand(this.writeRequest(descriptor.handle, data, false), function(data) {
    var opcode = data[0];

    if (opcode === ATT_OP_WRITE_RESP) {
      this.emit('valueWrite', this._address, serviceUuid, characteristicUuid, descriptorUuid);
    }
  }.bind(this));
};

L2capBle.prototype.readHandle = function(handle) {
  this._queueCommand(this.readRequest(handle), function(data) {
    var opcode = data[0];

    if (opcode === ATT_OP_READ_RESP) {
      this.emit('handleRead', this._address, handle, data.slice(1));
    }
  }.bind(this));
};

L2capBle.prototype.writeHandle = function(handle, data, withoutResponse) {
  if (withoutResponse) {
    this._queueCommand(this.writeRequest(handle, data, true), null, function() {
      this.emit('handleWrite', this._address, handle);
    }.bind(this));
  } else {
    this._queueCommand(this.writeRequest(handle, data, false), function(data) {
      var opcode = data[0];

      if (opcode === ATT_OP_WRITE_RESP) {
        this.emit('handleWrite', this._address, handle);
      }
    }.bind(this));
  }
};

module.exports = L2capBle;
