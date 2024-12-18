import { EventEmitter } from 'events';

export class BaseService extends EventEmitter {
  protected static instance: any = null;

  constructor() {
    super();
    if (BaseService.instance) {
      return BaseService.instance;
    }
    BaseService.instance = this;
  }
}