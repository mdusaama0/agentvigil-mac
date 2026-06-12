import chalk from 'chalk';

const timestamp = () => new Date().toISOString().substring(11, 23);

export const logger = {
  info:    (msg: string, ...args: any[]) => console.log(`${chalk.dim(timestamp())} ${chalk.blue('ℹ')} ${msg}`, ...args),
  success: (msg: string, ...args: any[]) => console.log(`${chalk.dim(timestamp())} ${chalk.green('✓')} ${msg}`, ...args),
  warn:    (msg: string, ...args: any[]) => console.warn(`${chalk.dim(timestamp())} ${chalk.yellow('⚠')} ${msg}`, ...args),
  error:   (msg: string, ...args: any[]) => console.error(`${chalk.dim(timestamp())} ${chalk.red('✗')} ${msg}`, ...args),
  dim:     (msg: string, ...args: any[]) => console.log(`${chalk.dim(timestamp())} ${chalk.dim(msg)}`, ...args),
  banner:  (msg: string) => console.log('\n' + chalk.bold.cyan(msg) + '\n'),
};
