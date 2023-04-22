"use client"

import { useEffect, useState } from "react"

import { useStore } from "@/lib/stores/layout"
import { Profile } from "@/lib/types/supabase"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSupabase } from "@/components/auth/supabase-provider"
import { Icons } from "@/components/shared/icons"

export function AccountToggle() {
  const [profile, setProfile] = useState<Profile>()
  const { session } = useStore()
  const userId = session?.user.id
  const { supabase } = useSupabase()

  useEffect(() => {
    const getProfile = async () => {
      const { data } = await supabase
        .from("profile")
        .select("*")
        .eq("id", userId)
        .single()
      setProfile(data ?? undefined)
    }

    getProfile()
  }, [userId])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 rounded-full border hover:border-primary-borderHover"
        >
          <Avatar className="h-7 w-7">
            <AvatarImage
              src={
                profile?.avatar_url ?? `https://avatar.vercel.sh/account.png`
              }
              alt={profile?.username}
            />
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" forceMount className="w-56">
        <DropdownMenuLabel>My Account</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <Icons.user className="mr-2 h-4 w-4" />
            <span>Profile</span>
            <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Icons.billing className="mr-2 h-4 w-4" />
            <span>Billing</span>
            <DropdownMenuShortcut>⌘B</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Icons.settings className="mr-2 h-4 w-4" />
            <span>Settings</span>
            <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem>
            <Icons.users className="mr-2 h-4 w-4" />
            <span>Organization</span>
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Icons.add className="mr-2 h-4 w-4" />
            <span>New Organization</span>
            <DropdownMenuShortcut>⌘+T</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />

        <DropdownMenuItem>
          <Icons.lifeBuoy className="mr-2 h-4 w-4" />
          <span>Support</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={async () => {
            await supabase.auth.signOut()
          }}
        >
          <Icons.logOut className="mr-2 h-4 w-4" />
          <span>Log out</span>
          <DropdownMenuShortcut>⇧⌘Q</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
