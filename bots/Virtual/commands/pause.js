const path = require('path');
const botFsmDefinitions = require(path.join(process.env.PWD, 'react/modules/Bots/botFsmDefinitions'));
const jobFsmDefinitions = require(path.join(process.env.PWD, 'react/modules/Jobs/jobFsmDefinitions'));

module.exports = async function pause(self, params) {
  try {
    if (self.currentJob === undefined) {
      throw new Error(`Bot ${self.settings.name} is not currently processing a job`);
    }
    if (!botFsmDefinitions.metaStates.pauseable.includes(self.fsm.current)) {
      throw new Error(`Cannot pause bot from state "${self.fsm.current}"`);
    }
    if (self.currentJob.fsm.current !== 'running') {
      throw new Error(`Cannot pause job from state "${self.currentJob.fsm.current}"`);
    }

    const commandArray = [];

    // We want pause to happen in a very specific order
    // 1. Start pause from the state machine immediately
    // 2. Allow for pause movements / macros / etc
    // 3. Complete state machine pause transition by signaling that pause is complete
    //
    // In order to accomplish this, we must prepend the current commands in the queue
    // We prepend 1
    // We call the state machine command "pause"
    // In the postCallback of 1, we prepend 2 to the queue
    // Then in the postCallback of 2, we prepend 3 to the queue
    //
    // This comes across a bit backwards, but the ordering is necessary in order to prevent
    // transitioning to an incorrect state

    const pauseEndCommand = {
      postCallback: () => {
        self.fsm.pauseDone();
      },
    };

    let pausedPosition = {
      x: undefined,
      y: undefined,
      z: undefined,
      e: undefined,
    };
    const m114Regex = /.*X:([+-]?\d+(\.\d+)?)\s*Y:([+-]?\d+(\.\d+)?)\s*Z:([+-]?\d+(\.\d+)?)\s*E:([+-]?\d+(\.\d+)?).*/;
    const pauseMovementCommand = [
      'M400',
      {
        // When pausing capture the position so that we can come back to it
        preCallback: () => {
          self.logger.debug('Starting pause movements');
        },
        code: 'M114',
        processData: (command, data) => {
          const parsedPosition = data.match(m114Regex);
          self.pausedPosition = {
            x: Number(parsedPosition[1]) - Number(self.settings.offsetX),
            y: Number(parsedPosition[3]) - Number(self.settings.offsetY),
            z: Number(parsedPosition[5]) - Number(self.settings.offsetZ),
            e: Number(parsedPosition[7])
          }
          return true;
        }
      },
      // add in height handling
      {
        preCallback: () => {
          pausedPosition = self.pausedPosition;
        },
        code: `G1 Z${pausedPosition.z + 10}`,
      },
      {
        postCallback: () => {
          self.queue.prependCommands(pauseEndCommand);
        }
      },
    ];

    // Pause the job
    self.queue.prependCommands({
      postCallback: () => {
        self.logger.debug('Starting pause command');
        // This line of code is not being reached.
        self.currentJob.pause();
        // Note, we don't return the pause request until the initial pause command is processed by the queue
        self.queue.prependCommands(pauseMovementCommand);
      },
    });

    if (self.fsm.current === 'blocking' || self.fsm.current === 'unblocking') {
      commandArray.unshift({
        postCallback: () => {
          self.logger.debug('Just queued pause', self.getBot().settings.name, self.fsm.current);
          self.pauseableState = self.fsm.current;
          self.fsm.pause();
        }
      });
      self.queue.queueCommands(commandArray);
    } else {
      self.queue.prependCommands(commandArray);
      self.logger.debug('Just queued pause', self.getBot().settings.name, self.fsm.current);
      self.pauseableState = self.fsm.current;
      self.fsm.pause();
    }
  } catch (ex) {
    self.logger.error('Pause error', ex);
  }

  return self.getBot();
};
