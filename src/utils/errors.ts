export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export function die(message: string): never {
  throw new CliError(message);
}
