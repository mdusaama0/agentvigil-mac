declare module 'qrcode-terminal' {
  interface GenerateOptions {
    small?: boolean;
  }

  const qrcodeTerminal: {
    generate: (input: string, options?: GenerateOptions, callback?: (qrcode: string) => void) => void;
  };
  export default qrcodeTerminal;
}
