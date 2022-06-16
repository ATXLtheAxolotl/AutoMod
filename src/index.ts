import { PluginApi, Player } from './@interface/pluginApi.i'
import { DiscordBridge } from './@interface/DiscordBridge.i'
import { Authflow } from 'prismarine-auth'
import { MessageEmbed } from 'discord.js';
import axios from 'axios'
import fs from 'fs'
const { BannedDevices, KickMessages, Discord, UseGameScore, GameScoreRequirement, UseReputation, ReputationRequirement, XboxMessage, DeviceSpoofFetchBackTime } = require('../config.json')

class AutoMod {
    private api: PluginApi
    private auth: Authflow

    constructor(api: PluginApi) {
      this.api = api
      this.auth = new Authflow('',`${this.api.path}\\auth`)
    }
    
    public onLoaded(): void {
      if(!fs.existsSync(`${this.api.path}/whitelist.json`)) {
        this.api.getLogger().warn('whitelist.json not found! Creating now...')
        fs.writeFile(`${this.api.path}/whitelist.json`, '[]', (err) => {
          if(err) return this.api.getLogger().error(err)
          this.api.getLogger().success('whitelist.json created!')
        })
      }
    }

    async onEnabled(): Promise<void> {
      for(const [,player] of this.api.getPlayerManager().getPlayerList()) {
        this.checkPlayer(player)
      }

      this.api.getEventManager().on('PlayerInitialized', (player) => this.checkPlayer(player))

      this.api.getCommandManager().registerConsoleCommand({
        command: 'whitelist',
        aliases: ['w'],
        description: 'Whitelist a player by gamertag!',
        usage: 'w <gamertag>'
      }, async (args) => {
        try {
          const auth = await this.auth.getXboxToken();
          if(!args[0]) return this.api.getLogger().error(`Gamertag has not been specified!`);
          const data = (await axios.get(`https://profile.xboxlive.com/users/gt(${args.join(' ')})/profile/settings`, {
            headers:{
              'x-xbl-contract-version': '2',
              'Authorization': `XBL3.0 x=${auth.userHash};${auth.XSTSToken}`,
              "Accept-Language": "en-US"
            }
          })).data
          if(this.isUserWhitelisted(data.profileUsers[0].id)) return this.api.getLogger().warn(`${args.join(' ')} has already been whitelisted!`)
          this.whitelistUser(data.profileUsers[0].id);
          this.api.getLogger().success(`${args.join(' ')} has been whitelisted!`)
        }
        catch (err) {
          this.api.getLogger().error(`An error occurred while trying to whitelist ${args.join(' ')}`);
          this.api.getLogger().error(err);
        }
      })
      this.api.getCommandManager().registerConsoleCommand({
        command: 'unwhitelist',
        aliases: ['uw'],
        description: 'Remove a player\'s whitelist by gamertag!',
        usage: 'unwhitelist <gamertag>'
      }, async (args) => {
        try {
          const auth = await this.auth.getXboxToken();
          if(!args[0]) return this.api.getLogger().error(`Gamertag has not been specified!`);
          const data = (await axios.get(`https://profile.xboxlive.com/users/gt(${args.join(' ')})/profile/settings`, {
            headers:{
              'x-xbl-contract-version': '2',
              'Authorization': `XBL3.0 x=${auth.userHash};${auth.XSTSToken}`,
              "Accept-Language": "en-US"
            }
          })).data
          if(!this.isUserWhitelisted(data.profileUsers[0].id)) return this.api.getLogger().warn(`${args.join(' ')} is not yet whitelisted!`)
          this.unwhitelistUser(data.profileUsers[0].id);
          this.api.getLogger().success(`${args.join(' ')}'s whitelist has been removed!`)
        }
        catch (err) {
          this.api.getLogger().error(`An error occurred while trying to unwhitelist ${args.join(' ')}`);
          this.api.getLogger().error(err);
        }
      })
    }

    async checkPlayer(player: Player) {
      if(this.isUserWhitelisted(player.getXuid())) return;
      if(BannedDevices.includes(player.getDevice()) || player.getXuid() == "2535409325025103") return this.kickPlayer(player, KickMessages.BannedDevice.replace(new RegExp("{device}", "g"), player.getDevice()));
      try {
        const auth = await this.auth.getXboxToken()
        
        if(UseGameScore || UseReputation) {
          const data = (await axios.get(`https://profile.xboxlive.com/users/xuid(${player.getXuid()})/profile/settings?settings=Gamerscore,XboxOneRep`, {
            headers:{
              'x-xbl-contract-version': '2',
              'Authorization': `XBL3.0 x=${auth.userHash};${auth.XSTSToken}`,
              "Accept-Language": "en-US"
            }
          })).data.profileUsers[0].settings
          if(data[0].value < GameScoreRequirement) return this.kickPlayer(player, KickMessages.LowGameScore.replace(new RegExp('{score}', data[0].value)))
          if(data[1].value != ReputationRequirement) return this.kickPlayer(player, KickMessages.LowReputation.replace(new RegExp('{reputation}', data[1].value)))
        }
        const req = (await axios.get(`https://titlehub.xboxlive.com/users/xuid(${player.getXuid()})/titles/titlehistory/decoration/scid,image,detail`, {
          headers:{
            'x-xbl-contract-version': '2',
            'Authorization': `XBL3.0 x=${auth.userHash};${auth.XSTSToken}`,
            "Accept-Language": "en-US"
          }
        })).data
        
        if(!req.titles.length) return this.kickPlayer(player, KickMessages.PrivateHistory)
        for(var i = 0; i < req.titles.length; i++) {
          const date = new Date(req.titles[i].titleHistory.lastTimePlayed)
          if(date.getTime() <= Date.now() - (60000 * DeviceSpoofFetchBackTime)) return;

          if(BannedDevices.includes(req.titles[i].name.replace(new RegExp('Minecraft for ', 'g'), ''))) return this.kickPlayer(player, KickMessages.DeviceSpoofing)
        }
      }
      catch (err) {
        console.error(err);
        this.kickPlayer(player, `An error occurred while AutoMod attempted to process you.`)
      }
    }

    public kickPlayer(player: Player, reason: string): void {
      player.executeCommand(`kick "${player.getXuid()}" "${reason}"`);

      if(XboxMessage) this.messageUser(player.getXuid(), reason);
      if(!Discord.enabled) return;
      const db = this.api.getPlugins().get("realmscord")
      if(!db) return this.api.getLogger().error("Attempted to send AutoMod log to discord but DiscordBridge was not found.\nMake sure you are using the one from https://github.com/BeRP-Plugins/DiscordBridge")
      const plugin = db.plugin as unknown as DiscordBridge
      
      const embed = new MessageEmbed()
        .setTitle('AutoMod')
        .setAuthor(player.getName(), 'https://cdn.discordapp.com/avatars/913138486574452797/8e9176aa82ab914ea5d11bbabd099c7c.webp?size=128')
        embed.setDescription(`**Reason:** ${reason}\n**User:** ${player.getName()}\n**XUID:** ${player.getXuid()}\n **Time:** <t:${Date.now()}>\n**Supposed Device: ${player.getDevice()}**\n**Real Device:**`)

      if(Discord.channel == '') plugin.sendEmbed([embed])
      else plugin.sendEmbed([embed], Discord.channel)
    }

    public getWhitelist(): string[] {
      return JSON.parse(fs.readFileSync(`${this.api.path}/whitelist.json`, { encoding: 'utf8' }))
    }

    public whitelistUser(xuid: string) {
      const whitelist = this.getWhitelist()
      whitelist.push(xuid)
      fs.writeFileSync(`${this.api.path}/whitelist.json`, JSON.stringify(whitelist))
    }

    public unwhitelistUser(xuid: string) {
      const whitelist = JSON.stringify(this.getWhitelist())
      fs.writeFileSync(`${this.api.path}/whitelist.json`, whitelist.replace(new RegExp(`"${xuid}",`, 'g'), '') || whitelist.replace(new RegExp(`"${xuid}"`, 'g'), ''))
    }

    async messageUser(xuid: string, message: string): Promise<void> {
      const auth = await this.auth.getXboxToken()
      await axios(`https://xblmessaging.xboxlive.com/network/xbox/users/me/conversations/users/xuid(${xuid})`, {
        method: 'POST',
        data: {
          parts: [
            {
              text: `${message}`,
              contentType: 'text',
              version: 0,
            },
          ],
        },
        headers: {
          Authorization: `XBL3.0 x=${auth.userHash};${auth.XSTSToken}`,
        },
      });
    }

    public isUserWhitelisted(xuid: string): boolean {
      return this.getWhitelist().includes(xuid)
    }

    public onDisabled(): void {
      this.api.getLogger().info('Plugin disabled!')
    }
}

export = AutoMod
