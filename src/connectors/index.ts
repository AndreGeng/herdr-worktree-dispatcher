import { FeishuBaseConnector } from './feishuBase.js';
import { ConnectorRegistry } from './registry.js';

export function createConnectorRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(new FeishuBaseConnector());
  return registry;
}
