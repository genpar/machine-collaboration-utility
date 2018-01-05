const path = require('path');
const _ = require('lodash');

const VirtualBot = require('../Virtual');

const connect = require('./commands/connect');
const generateParkCommands = require('./commands/generateParkCommands');
const generateUnparkCommands = require('./commands/generateUnparkCommands');

const info = {
  connectionType: 'serial',
  fileTypes: ['.gcode'],
  vidPid: [
    {
      vid: 0x0403,
      pid: 0x6001,
    },
  ],
  baudrate: 115200,
  checksumSupport: true,
};

const settings = {
  name: 'Melzi Bot',
  model: 'Melzi',
};

const commands = {
  connect,
  generateParkCommands,
  generateUnparkCommands,
};

module.exports = {
  info: _.extend(Object.assign({}, VirtualBot.info), info),
  settings: _.extend(Object.assign({}, VirtualBot.settings), settings),
  commands: _.extend(Object.assign({}, VirtualBot.commands), commands),
};
