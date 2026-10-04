export default function setup() {
  return () => {
    process.exitCode = 7;
  };
}
