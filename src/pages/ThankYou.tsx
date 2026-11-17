import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { RevealAnimation } from "@/components/RevealAnimation";
import { SEO } from "@/components/SEO";
import { trackFormConversion } from "@/lib/adsConversions";

const notes = [
  {
    numeral: "I",
    title: "Considered",
    body: "Every detail you shared is read by the team who will build your house.",
  },
  {
    numeral: "II",
    title: "Conversation",
    body: "A private consultation, by appointment, at your convenience.",
  },
  {
    numeral: "III",
    title: "Commission",
    body: "From the first sketch to the final hand-set stone, one house at a time.",
  },
] as const;

const ThankYou = () => {
  const [params] = useSearchParams();
  const form = params.get("form");
  const isStyleBook = form === "stylebook";
  const opening = isStyleBook
    ? "Your Style Book selection is now with our Worth Avenue atelier."
    : "Your note is now with our Worth Avenue atelier.";

  useEffect(() => {
    if (form === "contact" || form === "stylebook") trackFormConversion(form);
  }, [form]);

  return (
    <>
      <SEO
        title="Thank You"
        description="Your inquiry has been received by Beau Monde Builders. A member of our team will reply within one business day."
        path="/thank-you"
        noIndex
      />
      <div className="min-h-screen bg-background flex flex-col">
        <Navigation />

        <main className="flex-1">
          <section className="pt-32 md:pt-40 pb-10 md:pb-16">
            <div className="container mx-auto max-w-7xl px-4 sm:px-6">
              <div className="border-b border-accent/20 pb-16 md:pb-20 animate-fade-in">
                <p className="text-[10px] md:text-[11px] tracking-[0.4em] uppercase text-accent font-sans font-medium mb-6 md:mb-8">
                  Your Inquiry Has Been Received
                </p>
                <div className="h-px w-16 bg-accent mb-8 md:mb-10" aria-hidden="true" />
                <h1 className="font-display italic font-light leading-[0.9] tracking-tight text-foreground text-5xl sm:text-6xl md:text-7xl lg:text-8xl">
                  Thank you.
                </h1>
                <p className="mt-8 md:mt-10 max-w-2xl font-sans text-foreground/70 font-light leading-relaxed text-base md:text-lg">
                  {opening} A member of the Beau Monde team will reply personally within one business day to arrange a private conversation.
                </p>
                <p className="mt-4 max-w-2xl font-sans text-foreground/70 font-light leading-relaxed text-base md:text-lg">
                  A confirmation has been sent to your inbox.
                </p>
              </div>
            </div>
          </section>

          <RevealAnimation animation="luxury-reveal">
            <section className="pb-20 md:pb-32">
              <div className="container mx-auto max-w-7xl px-4 sm:px-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-12 md:gap-10 lg:gap-16">
                  {notes.map((note) => (
                    <article key={note.numeral} className="min-w-0 border-t border-accent/20 pt-8">
                      <p className="font-display italic font-light text-accent text-3xl md:text-4xl leading-none mb-4">
                        {note.numeral}
                      </p>
                      <h2 className="text-[10px] md:text-[11px] tracking-[0.35em] uppercase text-accent font-sans font-medium mb-4">
                        {note.title}
                      </h2>
                      <p className="font-sans text-foreground/70 font-light leading-relaxed text-base">
                        {note.body}
                      </p>
                    </article>
                  ))}
                </div>

                <div className="mt-16 md:mt-20 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-4 sm:gap-6">
                  <Link
                    to="/projects"
                    className="group relative inline-flex items-center justify-center bg-primary text-primary-foreground px-14 md:px-20 py-5 md:py-6 text-[10px] md:text-[11px] font-sans font-light tracking-[0.3em] uppercase ring-1 ring-inset ring-accent/30 hover:ring-accent/60 transition-all duration-500 hover:-translate-y-px hover:shadow-[0_18px_40px_-20px_hsl(var(--primary)/0.55)] touch-manipulation text-center"
                  >
                    <span className="relative inline-block">
                      Find Your Style
                      <span className="pointer-events-none absolute -bottom-1.5 left-0 h-px w-0 bg-accent transition-all duration-700 ease-out group-hover:w-full" aria-hidden="true" />
                    </span>
                  </Link>
                  <a
                    href="tel:+15616468992"
                    className="group relative inline-flex items-center justify-center bg-primary text-primary-foreground px-14 md:px-20 py-5 md:py-6 text-[10px] md:text-[11px] font-sans font-light tracking-[0.3em] uppercase ring-1 ring-inset ring-accent/30 hover:ring-accent/60 transition-all duration-500 hover:-translate-y-px hover:shadow-[0_18px_40px_-20px_hsl(var(--primary)/0.55)] touch-manipulation text-center"
                  >
                    <span className="relative inline-block">
                      Call (561) 646-8992
                      <span className="pointer-events-none absolute -bottom-1.5 left-0 h-px w-0 bg-accent transition-all duration-700 ease-out group-hover:w-full" aria-hidden="true" />
                    </span>
                  </a>
                </div>
              </div>
            </section>
          </RevealAnimation>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default ThankYou;
