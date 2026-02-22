import { HeroCreature } from "./hero-creature";

export function FloatingCreature() {
  return (
    <div className="fixed inset-0 pointer-events-none z-0 creature-enter">
      <HeroCreature />
    </div>
  );
}
