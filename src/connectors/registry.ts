import { die } from '../utils/errors.js';
import type { TaskConnector } from './types.js';

export class ConnectorRegistry {
  private readonly connectors = new Map<string, TaskConnector>();

  register(connector: TaskConnector): void {
    if (this.connectors.has(connector.type)) die(`connector already registered: ${connector.type}`);
    this.connectors.set(connector.type, connector);
  }

  list(): TaskConnector[] {
    return [...this.connectors.values()].sort((a, b) => a.type.localeCompare(b.type));
  }

  get(type: string): TaskConnector {
    const connector = this.connectors.get(type);
    if (!connector) {
      const available = this.list().map((item) => item.type).join(', ') || 'none';
      die(`unknown connector: ${type} (available: ${available})`);
    }
    return connector;
  }

  resolve(source: string, explicitType?: string): TaskConnector {
    if (explicitType) return this.get(explicitType);
    const matches = this.list().filter((connector) => connector.canHandle(source));
    if (matches.length === 0) {
      const available = this.list().map((item) => item.type).join(', ') || 'none';
      die(`no connector can handle source: ${source} (available: ${available})`);
    }
    if (matches.length > 1) {
      die(`multiple connectors can handle source; use --connector: ${matches.map((item) => item.type).join(', ')}`);
    }
    return matches[0];
  }
}
