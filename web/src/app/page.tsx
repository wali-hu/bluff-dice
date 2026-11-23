import { FeatureStrip } from "@/components/FeatureStrip";
import { Hero } from "@/components/Hero";
import { PlayCta } from "@/components/PlayCta";
import { PLAY_ESTIMATE } from "@/lib/estimate";

export default function HomePage() {
  return (
    <div className="container">
      <Hero />
      <PlayCta estimate={PLAY_ESTIMATE} />
      <FeatureStrip />
    </div>
  );
}
