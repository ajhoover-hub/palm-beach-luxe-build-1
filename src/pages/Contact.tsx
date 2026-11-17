import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { RevealAnimation } from "@/components/RevealAnimation";
import { SEO } from "@/components/SEO";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";

const PROJECT_TYPES = ["New custom home", "Renovation", "Addition"] as const;
const TIMELINES = ["0-6 months", "6-12 months", "12+ months", "Just exploring"] as const;
const LOT_OPTIONS = ["Yes", "No", "Looking"] as const;
/** Placeholder brackets until the real investment ranges are chosen. */
const INVESTMENT_RANGES = [
  "[RANGE 1 — TBD]",
  "[RANGE 2 — TBD]",
  "[RANGE 3 — TBD]",
  "[RANGE 4 — TBD]",
] as const;

const optionalListed = (options: readonly string[]) =>
  z.string().refine((value) => value === "" || options.includes(value), "Choose a listed option");

const contactSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  email: z.string().trim().email("A valid email is required"),
  phone: z.string().trim(),
  message: z.string().trim().min(1, "Tell us about your vision"),
  projectType: z.string().refine(
    (value) => (PROJECT_TYPES as readonly string[]).includes(value),
    "Choose a project type",
  ),
  timeline: optionalListed(TIMELINES),
  ownsLot: optionalListed(LOT_OPTIONS),
  investmentRange: optionalListed(INVESTMENT_RANGES),
});

const Contact = () => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    message: "",
    projectType: "",
    timeline: "",
    ownsLot: "",
    investmentRange: "",
  });
  const { toast } = useToast();
  const navigate = useNavigate();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { id, value } = e.target;
    setFormData((prev) => ({ ...prev, [id]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = contactSchema.safeParse(formData);
    if (!parsed.success) {
      toast({
        title: "Please review",
        description: parsed.error.issues[0]?.message ?? "Please review the form.",
        variant: "destructive",
      });
      return;
    }
    setIsSubmitting(true);

    try {
      const data = parsed.data;
      const fullName = `${data.firstName} ${data.lastName}`.trim();
      const inquiry = {
        projectType: data.projectType,
        timeline: data.timeline,
        ownsLot: data.ownsLot,
        investmentRange: data.investmentRange,
      };

      // 1. Internal notification to the office
      const { error: notifyError } = await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName: "contact-notification",
          idempotencyKey: `contact-notify-${Date.now()}-${data.email}`,
          templateData: {
            fullName,
            email: data.email,
            phone: data.phone,
            message: data.message,
            ...inquiry,
          },
        },
      });
      if (notifyError) throw notifyError;

      // 2. Confirmation back to the submitter
      const { error: confirmError } = await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName: "contact-confirmation",
          recipientEmail: data.email,
          idempotencyKey: `contact-confirm-${Date.now()}-${data.email}`,
          templateData: { firstName: data.firstName, ...inquiry },
        },
      });
      if (confirmError) throw confirmError;

      navigate("/thank-you?form=contact");
    } catch (error: any) {
      console.error("Error sending message:", error);
      toast({
        title: "Error",
        description: "Failed to send message. Please try again or call us directly.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <SEO
        title="Contact the Palm Beach Office | Beau Monde Builders"
        description="Contact Beau Monde Builders at 205 Worth Avenue, Suite 120, Palm Beach, FL 33480, or call (561) 646-8992. By appointment."
        path="/contact"
        pageType="ContactPage"
        breadcrumbs={[
          { name: "Home", path: "/" },
          { name: "Contact", path: "/contact" },
        ]}
      />
      <div className="min-h-screen bg-background">
        <Navigation />

        {/* Editorial atelier layout */}
        <section className="pt-32 md:pt-40 pb-10 md:pb-16">
          <div className="container mx-auto max-w-7xl px-4 sm:px-6">
            <div className="flex flex-col md:flex-row items-baseline gap-10 md:gap-24 border-b border-accent/20 pb-16 md:pb-20 animate-fade-in">
              <div className="flex-1">
                <p className="text-[10px] md:text-[11px] tracking-[0.4em] uppercase text-accent font-sans font-medium mb-6 md:mb-8">
                  Begin Your Journey
                </p>
                <h1 className="font-display italic font-light leading-[0.9] tracking-tight text-foreground text-5xl sm:text-6xl md:text-7xl lg:text-8xl">
                  Let's Create Something
                  <span className="block not-italic font-light opacity-90">Extraordinary</span>
                </h1>
              </div>
              <div className="md:w-1/3">
                <p className="font-sans text-foreground/70 font-light leading-relaxed text-base md:text-lg">
                  Our office accepts a limited number of commissions each year. Share your vision and we will respond within one business day to arrange a private consultation on Worth Avenue.
                </p>
              </div>
            </div>
          </div>
        </section>

        <RevealAnimation animation="luxury-reveal">
          <section className="pb-20 md:pb-32">
            <div className="container mx-auto max-w-7xl px-4 sm:px-6">
              <div className="grid lg:grid-cols-12 gap-16 lg:gap-24 items-start">
                {/* Form */}
                <form onSubmit={handleSubmit} className="lg:col-span-7 space-y-12 md:space-y-14">
                  <div className="grid md:grid-cols-2 gap-10 md:gap-12">
                    <FieldUnderline id="firstName" label="First Name" value={formData.firstName} onChange={handleInputChange} required />
                    <FieldUnderline id="lastName" label="Last Name" value={formData.lastName} onChange={handleInputChange} required />
                  </div>
                  <div className="grid md:grid-cols-2 gap-10 md:gap-12">
                    <FieldUnderline id="email" type="email" label="Direct Email" value={formData.email} onChange={handleInputChange} required placeholder="you@example.com" />
                    <FieldUnderline id="phone" type="tel" label="Contact Phone" value={formData.phone} onChange={handleInputChange} placeholder="(561) 000-0000" />
                  </div>
                  <div className="grid md:grid-cols-2 gap-10 md:gap-12">
                    <SelectUnderline id="projectType" label="Project Type" value={formData.projectType} onChange={handleInputChange} required options={PROJECT_TYPES} placeholder="Select" />
                    <SelectUnderline id="timeline" label="Timeline" value={formData.timeline} onChange={handleInputChange} options={TIMELINES} placeholder="Select" />
                  </div>
                  <div className="grid md:grid-cols-2 gap-10 md:gap-12">
                    <SelectUnderline id="ownsLot" label="Do you own a lot?" value={formData.ownsLot} onChange={handleInputChange} options={LOT_OPTIONS} placeholder="Select" />
                    <SelectUnderline id="investmentRange" label="Investment Range" value={formData.investmentRange} onChange={handleInputChange} options={INVESTMENT_RANGES} placeholder="Select" />
                  </div>
                  <FieldUnderline id="message" label="Tell Us About Your Vision" value={formData.message} onChange={handleInputChange} required textarea placeholder="A few notes about your project, location, and timeline…" />

                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="group relative bg-primary text-primary-foreground px-14 md:px-20 py-5 md:py-6 text-[10px] md:text-[11px] font-sans font-light tracking-[0.3em] uppercase ring-1 ring-inset ring-accent/30 hover:ring-accent/60 transition-all duration-500 hover:-translate-y-px hover:shadow-[0_18px_40px_-20px_hsl(var(--primary)/0.55)] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none touch-manipulation"
                    >
                      <span className="relative inline-block">
                        {isSubmitting ? "Sending…" : "Talk to Beau Monde"}
                        <span className="pointer-events-none absolute -bottom-1.5 left-0 h-px w-0 bg-accent transition-all duration-700 ease-out group-hover:w-full group-disabled:w-0" aria-hidden="true" />
                      </span>
                    </button>
                  </div>
                </form>

                {/* Office info + location card */}
                <aside className="lg:col-span-5 flex flex-col gap-12 md:gap-16 animate-fade-in" style={{ animationDelay: "200ms" }}>
                  {/* Unified Palm Beach Office card */}
                  <div className="bg-card border border-accent/20 shadow-lifted overflow-hidden">
                    {/* Map */}
                    <a
                      href="https://www.google.com/maps/place/205+Worth+Ave,+Palm+Beach,+FL+33480"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block relative group overflow-hidden border-b border-accent/15"
                      aria-label="View 205 Worth Avenue on Google Maps"
                    >
                      <div className="aspect-[5/3] w-full overflow-hidden bg-muted">
                        <iframe
                          src="https://www.google.com/maps?q=205+Worth+Ave,+Palm+Beach,+FL+33480&output=embed"
                          width="100%"
                          height="100%"
                          style={{ border: 0, pointerEvents: "none" }}
                          loading="lazy"
                          referrerPolicy="no-referrer-when-downgrade"
                          title="205 Worth Avenue, Palm Beach"
                          className="w-full h-full"
                        />
                      </div>
                    </a>

                    <div className="p-8 md:p-10 space-y-8">
                      {/* Address */}
                      <div>
                        <h2 className="text-[9px] md:text-[10px] tracking-[0.35em] uppercase text-accent font-sans font-medium mb-4">Palm Beach Office</h2>
                        <p className="font-display text-2xl md:text-3xl text-foreground leading-tight">
                          205 Worth Avenue, Suite 120<br />Palm Beach, FL 33480
                        </p>
                      </div>

                      <div className="h-px w-full bg-accent/15" aria-hidden="true" />

                      {/* Phone + Email */}
                      <div>
                        <h4 className="text-[9px] md:text-[10px] tracking-[0.35em] uppercase text-accent font-sans font-medium mb-3">Direct Line</h4>
                        <a href="tel:+15616468992" className="font-display text-xl md:text-2xl text-foreground hover:text-accent transition-colors duration-500">
                          (561) 646-8992
                        </a>
                        <a href="mailto:aj@bmbpalmbeach.com" className="block font-sans text-sm text-foreground/70 hover:text-accent transition-colors duration-500 mt-1.5 font-light">
                          aj@bmbpalmbeach.com
                        </a>
                      </div>

                      <div className="h-px w-full bg-accent/15" aria-hidden="true" />

                      {/* Hours */}
                      <div>
                        <h4 className="text-[9px] md:text-[10px] tracking-[0.35em] uppercase text-accent font-sans font-medium mb-3">Hours</h4>
                        <div className="font-sans text-[13px] md:text-sm space-y-2 text-foreground/75 font-light">
                          <p className="flex justify-between"><span>Monday — Friday</span><span className="italic">By Appointment</span></p>
                          <p className="flex justify-between"><span>Saturday</span><span className="italic">By Appointment</span></p>
                          <p className="flex justify-between"><span>Sunday</span><span>Closed</span></p>
                        </div>
                      </div>

                      <div className="h-px w-full bg-accent/15" aria-hidden="true" />

                      {/* Get Directions */}
                      <a
                        href="https://www.google.com/maps/dir/?api=1&destination=205+Worth+Avenue%2C+Suite+120%2C+Palm+Beach%2C+FL+33480"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group inline-flex items-center gap-3 text-[10px] tracking-[0.35em] uppercase font-sans font-medium text-foreground hover:text-accent transition-colors duration-500"
                      >
                        <span className="relative">
                          Get Directions
                          <span className="absolute left-0 -bottom-1 h-px w-full bg-accent/40 group-hover:bg-accent transition-colors duration-500" aria-hidden="true" />
                        </span>
                        <span aria-hidden="true" className="transition-transform duration-500 group-hover:translate-x-1">→</span>
                      </a>
                    </div>
                  </div>
                </aside>
              </div>
            </div>
          </section>
        </RevealAnimation>

        <Footer />
      </div>
    </>
  );
};

const FieldUnderline = ({
  id,
  label,
  value,
  onChange,
  required,
  type = "text",
  placeholder,
  textarea,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
  textarea?: boolean;
}) => {
  const sharedClasses =
    "w-full bg-transparent border-b border-foreground/15 py-3 md:py-4 font-sans font-light text-base md:text-lg text-foreground placeholder:text-foreground/60 focus:outline-none transition-colors duration-500 peer";
  return (
    <div className="group relative">
      <label htmlFor={id} className="block text-[9px] md:text-[10px] tracking-[0.35em] uppercase text-accent font-sans font-medium mb-1">
        {label}
      </label>
      {textarea ? (
        <textarea id={id} rows={4} value={value} onChange={onChange} required={required} placeholder={placeholder} className={`${sharedClasses} resize-none`} />
      ) : (
        <input id={id} type={type} value={value} onChange={onChange} required={required} placeholder={placeholder} className={sharedClasses} />
      )}
      <span className="pointer-events-none absolute bottom-0 left-0 h-px w-0 bg-accent transition-all duration-500 peer-focus:w-full" aria-hidden="true" />
    </div>
  );
};

const SelectUnderline = ({
  id,
  label,
  value,
  onChange,
  required,
  options,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  required?: boolean;
  options: readonly string[];
  placeholder: string;
}) => (
  <div className="group relative min-w-0">
    <label htmlFor={id} className="block text-[9px] md:text-[10px] tracking-[0.35em] uppercase text-accent font-sans font-medium mb-1">
      {label}
    </label>
    <select
      id={id}
      value={value}
      onChange={onChange}
      required={required}
      className="w-full max-w-full bg-transparent border-b border-foreground/15 py-3 md:py-4 pr-6 font-sans font-light text-base md:text-lg text-foreground focus:outline-none transition-colors duration-500 peer appearance-none"
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
    <span className="pointer-events-none absolute bottom-0 left-0 h-px w-0 bg-accent transition-all duration-500 peer-focus:w-full" aria-hidden="true" />
  </div>
);

const InfoBlock = ({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) => (
  <div className="relative pl-6 md:pl-8">
    <span className="absolute left-0 top-1 bottom-1 w-px bg-accent/40" aria-hidden="true" />
    <h3 className="text-[9px] md:text-[10px] tracking-[0.35em] uppercase text-accent font-sans font-medium mb-3">{eyebrow}</h3>
    {children}
  </div>
);

export default Contact;
