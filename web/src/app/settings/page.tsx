"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { User, CreditCard, BarChart3, Webhook } from "lucide-react";

interface Profile {
  name: string;
  email: string;
  plan: "free" | "pro";
  minutesUsed: number;
  minutesQuota: number;
}

export default function SettingsPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile>({
    name: "User",
    email: "user@example.com",
    plan: "free",
    minutesUsed: 3.2,
    minutesQuota: 5,
  });
  const [webhookUrl, setWebhookUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem("token")) {
      router.push("/login");
    }
    // In production, fetch user profile from /me endpoint and call setProfile
  }, [router]);

  async function saveProfile() {
    setSaving(true);
    // In production, call api.updateProfile(profile.name, webhookUrl)
    await new Promise((r) => setTimeout(r, 500));
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-bold text-white">Settings</h1>
      <p className="mt-1 text-sm text-slate-400">
        Manage your account and preferences
      </p>

      <div className="mt-8 space-y-6">
        {/* Profile */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-slate-400" />
              <CardTitle>Profile</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-300">
                Name
              </label>
              <Input
                value={profile.name}
                onChange={(e) => {
                  setProfile((p) => ({ ...p, name: e.target.value }));
                  setSaved(false);
                }}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-300">
                Email
              </label>
              <Input value={profile.email} disabled />
              <p className="mt-1 text-xs text-slate-500">
                Email cannot be changed
              </p>
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={saveProfile} disabled={saving} size="sm">
              {saving ? "Saving..." : saved ? "Saved!" : "Save changes"}
            </Button>
          </CardFooter>
        </Card>

        {/* Plan */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-slate-400" />
              <CardTitle>Plan</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <Badge variant={profile.plan === "pro" ? "indigo" : "default"}>
                {profile.plan === "pro" ? "Pro" : "Free"}
              </Badge>
              <span className="text-sm text-slate-400">
                {profile.plan === "pro"
                  ? "Unlimited minutes, all premium features"
                  : "5 minutes per month, basic features"}
              </span>
            </div>
          </CardContent>
          <CardFooter>
            {profile.plan === "free" ? (
              <Button size="sm">Upgrade to Pro &mdash; $29/mo</Button>
            ) : (
              <Button variant="outline" size="sm">
                Manage subscription
              </Button>
            )}
          </CardFooter>
        </Card>

        {/* Usage */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-slate-400" />
              <CardTitle>Usage</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-300">Minutes used this month</span>
              <span className="text-slate-400">
                {profile.minutesUsed.toFixed(1)} / {profile.minutesQuota} min
              </span>
            </div>
            <Progress
              value={profile.minutesUsed}
              max={profile.minutesQuota}
              className="mt-3"
            />
            <div className="mt-4 grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-white">
                  {profile.minutesUsed.toFixed(1)}
                </p>
                <p className="text-xs text-slate-500">Minutes used</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-white">
                  {profile.minutesQuota}
                </p>
                <p className="text-xs text-slate-500">Quota</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-white">
                  {Math.max(
                    0,
                    profile.minutesQuota - profile.minutesUsed
                  ).toFixed(1)}
                </p>
                <p className="text-xs text-slate-500">Remaining</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Webhook */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Webhook className="h-4 w-4 text-slate-400" />
              <CardTitle>Webhook</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-slate-400">
              Receive notifications when jobs complete. We will POST a JSON
              payload to this URL.
            </p>
            <Input
              placeholder="https://your-server.com/webhooks/recast"
              value={webhookUrl}
              onChange={(e) => {
                setWebhookUrl(e.target.value);
                setSaved(false);
              }}
            />
          </CardContent>
          <CardFooter>
            <Button onClick={saveProfile} disabled={saving} size="sm">
              {saving ? "Saving..." : "Save webhook"}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
