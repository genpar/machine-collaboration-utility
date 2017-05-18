/* global logger */
const uuidGenerator = require('uuid/v4');
const StateMachine = require('javascript-state-machine');
const Stopwatch = require('timer-stopwatch');

const jobFsmDefinitions = require('../../../react/modules/Jobs/jobFsmDefinitions');
const jobModel = require('./model');

/**
 * Job()
 *
 * A Job object represents the execution of a file by a bot
 * The Job maintains its state, as well as info about the bot and file being used
 *
 * @param {string} app - The entire React app as rendered by the server
 * @param {object} botUuid - The uuid of the bot to be linked to this job
 * @param {object} fileUuid - The uuid of the file to be linked to this job
 * @param {object} initialState - Passed in case of restoring an old job
 * @param {object} id - The ID for the job as provided by the sql database
 * @param {object} subscribers - Array of endpoints that want to receie updates when job events occur
 * @param {object} jobUuid - Job uuid will be autogenerated
 *                           however the user can instead force a specific uuid instead
 *
 * @returns {Object} - A new Job object
 */
class Job {
  constructor(jobParams) {
    this.app = jobParams.app;
    this.botUuid = jobParams.botUuid;
    this.fileUuid = jobParams.fileUuid;
    this.uuid = jobParams.jobUuid !== undefined ? jobParams.jobUuid : uuidGenerator();

    this.initialState = jobParams.initialState;
    this.id = jobParams.id;
    this.subscribers = Array.isArray(jobParams.subscribers) ? jobParams.subscribers : [];
  }

  /**
   * initialize()
   *
   * Once the job object is created, it needs to set up its uuid, state machine,
   * stopwatch functionality, etc.
   *
   */
  async initialize() {
    this.JobModel = await jobModel(this.app);
    if (this.botUuid === undefined) {
      throw new Error('"botUuid" is not defined');
    }

    let initialState;
    if (this.initialState === 'complete' || this.initialState === 'canceled') {
      initialState = this.initialState;
    } else if (this.initialState === undefined) {
      initialState = 'initializing';
    } else {
      // If a job was canceled while running, set it to canceled
      // TODO Update it permanently to have a state of canceled in the database
      initialState = 'canceled';
    }

    const fsmSettings = {
      initial: initialState,
      error: (eventName, from, to, args, errorCode, errorMessage) => {
        const fsmError = `Invalid job ${this.uuid} state change on event "${eventName}" from "${from}" to "${to}"\nargs: "${args}"\nerrorCode: "${errorCode}"\nerrorMessage: "${errorMessage}"`;
        logger.error(fsmError);
        throw new Error(fsmError);
      },
      events: jobFsmDefinitions.fsmEvents,
      callbacks: {
        onenterstate: async (event, from, to) => {
          logger.info(`Job ${this.uuid} Bot ${this.botUuid} event ${event}: Transitioning from ${from} to ${to}.`);
          if (from !== 'none') {
            try {
              // As soon as an event successfully transistions, update it in the database
              const dbJob = await this.JobModel.findById(this.id);
              await Promise.delay(0); // For some reason this can't happen in the same tick
              await dbJob.updateAttributes({
                state: this.fsm.current,
                fileUuid: this.fileUuid,
                started: this.started,
                elapsed: this.stopwatch.ms,
                percentComplete: this.percentComplete,
              });
              logger.info(`Job event. ${event} for job ${this.uuid} successfully updated to ${this.fsm.current}`);
              this.app.io.broadcast('jobEvent', {
                uuid: this.uuid,
                event: 'update',
                data: this.getJob(),
              });
            } catch (ex) {
              logger.info(`Job event ${event} for job ${this.uuid} failed to update: ${ex}`);
            }
          }
        },
      },
    };

    this.fsm = StateMachine.create(fsmSettings);
    this.stopwatch = new Stopwatch(false, { refreshRateMS: 10000 });
    this.started = undefined;
    this.elapsed = undefined;
    this.percentComplete = 0;

    // job updates once a second
    this.stopwatch.onTime(() => {
      logger.info('jobEvent', this.getJob());
      this.app.io.broadcast('jobEvent', {
        uuid: this.uuid,
        event: 'update',
        data: this.getJob(),
      });
    });
    if (this.fsm.current === 'initializing') {
      this.fsm.initializationDone();
    }
  }

  /**
    * getJob()
    *
    * Turn a job object into a REST reply friendly object
    *
    * @returns {Object} - The job object, but filtered to contain only values, no functions
    */
  getJob() {
    const state = this.fsm.current ? this.fsm.current : 'ready';
    const started = !!this.started ? this.started : null;
    const elapsed = !!this.started ? this.stopwatch.ms || this.elapsed : null;
    return {
      botUuid: this.botUuid,
      uuid: this.uuid,
      state,
      fileUuid: this.fileUuid === undefined ? false : this.fileUuid,
      started,
      elapsed,
      percentComplete: this.percentComplete,
    };
  };

  /**
    * start()
    *
    * Start processing a job
    *
    */
  start() {
    if (this.fsm.current !== 'ready') {
      throw new Error(`Cannot start job from state ${this.fsm.current}`);
    }

    try {
      this.started = new Date().getTime();
      this.stopwatch.start();
      this.fsm.start();
    } catch (ex) {
      const errorMessage = `Job start failure ${ex}`;
      logger.error(errorMessage);
    }
  };

  /**
    * pause()
    *
    * Pause processing a job
    *
    */
  pause() {
    if (this.fsm.current === 'paused') {
      return;
    }
    if (this.fsm.current !== 'running') {
      throw new Error(`Cannot pause job from state ${this.fsm.current}`);
    }

    try {
      this.stopwatch.stop();
      this.fsm.pause();
    } catch (ex) {
      const errorMessage = `Job pause failure ${ex}`;
      logger.error(errorMessage);
    }
  };

  /**
   * resume()
   *
   * Resume processing a job
   *
   */
  resume() {
    if (this.fsm.current === 'running') {
      return;
    }
    if (this.fsm.current !== 'paused') {
      throw new Error(`Cannot resume job from state ${this.fsm.current}`);
    }
    try {
      this.stopwatch.start();
      this.fsm.resume();
    } catch (ex) {
      const errorMessage = `Job resume failure ${ex}`;
      logger.error(errorMessage);
    }
  };

  /**
   * cancel()
   *
   * Cancel the processing of a job
   *
   */
  cancel() {
    const processingJobStates = jobFsmDefinitions.metaStates.processingJob;
    if (!processingJobStates.includes(this.fsm.current)) {
      throw new Error(`Cannot cancel job from state "${this.fsm.current}"`);
    }
    try {
      this.stopwatch.stop();
      this.fsm.cancel();
    } catch (ex) {
      const errorMessage = `Job cancel failure ${ex}`;
      logger.error(errorMessage);
    }
  };

  complete() {
    if (this.fsm.current !== 'running') {
      throw new Error(`Cannot complete job from state "${this.fsm.current}"`);
    }
    this.fsm.completeJob();
    this.stopwatch.stop();
  };
}

module.exports = Job;
