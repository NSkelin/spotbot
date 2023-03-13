# Spotbot
The discord bot for your server hosting needs!

## Table of Contents
- [Overview](#overview)
- [Features](#features)
- [Built-With](#built-with)

## Overview
Spotbot is a Discord bot that integrates with the Discord API & and the Amazon Web Services API. It allows you and anyone else with access to the bot to automatically start EC2 instances in AWS with a simple command through Discord.

![Screenshot 2023-03-13 143638](https://user-images.githubusercontent.com/31994545/224837866-46953674-b1ee-465e-9d52-958ade778583.png)

The usecase this was made in mind with is to allow yourself and any of your friends to easily start a pre-configured multiplayer game server with a single command. Mainly so I dont have to start a server everytime someone asks, while also using my PC and therefore limiting the resources it has for my use.

It works by storing pre-configured game servers on AWS S3, which the bot then loads onto a EC2 spot instance when a user sends a command. These servers will automatically shutdown when no one is connected by monitoring the amount incoming and outgoing packets.

## Features
- Control multiplayer game servers with a single command through AWS EC2 instances.
- Allows your friends to start servers in discord without bugging you.
- Store your multiplayer servers and their savedata on AWS S3.
- Save money by using cheap AWS spot instances.
- Automatically shutdown when not in use. No need remind your friends to manually turn it off.

## Built-With
The major libraries/frameworks I used to make Spotbot.

- aws-cli-js
- discord.io
